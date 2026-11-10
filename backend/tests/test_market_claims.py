"""Phase 4: virtual shop units, merchants, claims (conflicts, limits, evidence, review,
release, expiry, transfer, disputes) and the walk-in shop floor in movement validation."""

import asyncio
import io
import math
from datetime import timedelta

import pytest
from shapely.geometry import Point, Polygon
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.database import SessionLocal
from app.geography.projection import default_projection
from app.marketplace import claims
from app.models import Building, PropertyClaim, VirtualProperty
from app.multiplayer.hub import hub
from app.utils.time import utcnow
from tests.conftest import (
    MERCHANT,
    approved_merchant,
    expect,
    free_units,
    merchant_id_of,
    onboard,
    send,
    world_socket,
)

PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"


# ── generated units ──────────────────────────────────────────────────────────────────


async def test_units_are_storefronts_of_real_non_residential_buildings():
    async with SessionLocal() as session:
        units = (await session.scalars(select(VirtualProperty))).all()
        assert len(units) > 1000
        assert len({u.code for u in units}) == len(units)
        kinds = {
            k
            for (k,) in await session.execute(
                select(Building.building).join(
                    VirtualProperty, VirtualProperty.building_id == Building.id
                )
            )
        }
        assert not kinds & {"residential", "apartments", "house", "terrace", "pagoda", "school"}
        for u in units[:300]:
            rect = Polygon(u.corners)
            assert math.isclose(rect.area, u.width_m * u.depth_m, rel_tol=0.01)
            # The door is the middle of the front edge, and the heading points out of it.
            (ax, az), (bx, bz) = u.corners[0], u.corners[1]
            assert math.hypot(u.door_x - (ax + bx) / 2, u.door_z - (az + bz) / 2) < 0.02
            out = Point(u.door_x + math.sin(u.heading), u.door_z + math.cos(u.heading))
            inside = Point(u.door_x - math.sin(u.heading), u.door_z - math.cos(u.heading))
            assert not rect.contains(out) and rect.contains(inside)
        # Storefronts face public streets (a few are unnamed in OpenStreetMap), never alleys.
        assert sum(1 for u in units if u.street_name) > 0.85 * len(units)
        # Units at a named real business must be verified before anyone can claim them.
        flagged = [u for u in units if u.requires_verification]
        assert flagged and all(u.real_business_name for u in flagged)


async def test_unit_map_api(client):
    units = await free_units(client, 5)
    detail = (await client.get(f"/market/units/{units[0]['code']}")).json()
    assert detail["status"] == "available" and len(detail["corners_ll"]) == 4
    huge = await client.get("/market/units", params={"bbox": "104.8,11.5,104.95,11.6"})
    assert huge.status_code == 400 and huge.json()["error"]["code"] == "BBOX_TOO_LARGE"
    assert (await client.get("/market/units/XX-9999")).status_code == 404


# ── merchants ────────────────────────────────────────────────────────────────────────


async def test_merchant_application_needs_admin_approval(client, admin_client):
    await onboard(client, "dara", roles=["buyer"])
    assert (await client.get("/merchant")).json()["error"]["code"] == "NO_MERCHANT"
    bad = await client.post("/merchant", json={**MERCHANT, "contact_phone": None})
    assert bad.status_code == 422  # customers need a way to reach the business
    response = await client.post("/merchant", json=MERCHANT)
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "pending"
    assert response.json()["seller_role"] == "pending"
    assert (await client.post("/merchant", json=MERCHANT)).status_code == 409

    unit = (await free_units(client))[0]
    denied = await client.post("/merchant/claims", json={"unit_code": unit["code"]})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "NOT_ELIGIBLE"

    doc = await client.post(
        "/merchant/documents",
        files={"file": ("licence.pdf", PDF, "application/pdf")},
        data={"kind": "business_registration"},
    )
    assert doc.status_code == 201, doc.text
    fake = await client.post(
        "/merchant/documents",
        files={"file": ("licence.pdf", b"<html>not a pdf</html>", "application/pdf")},
        data={"kind": "other"},
    )
    assert fake.status_code == 400 and fake.json()["error"]["code"] == "UNSUPPORTED_DOCUMENT"

    mid = await merchant_id_of(admin_client, "dara")
    # Not an admin: cannot approve themselves, cannot read documents.
    assert (await client.post(f"/admin/merchants/{mid}/approve", json={})).status_code == 403
    assert (await client.get(f"/admin/documents/{doc.json()['id']}")).status_code == 403
    file = await admin_client.get(f"/admin/documents/{doc.json()['id']}")
    assert file.status_code == 200 and file.content == PDF
    assert "attachment" in file.headers["content-disposition"]

    assert (await admin_client.post(f"/admin/merchants/{mid}/approve", json={})).status_code == 200
    me = (await client.get("/auth/me")).json()
    assert {"role": "seller", "status": "active"}.items() <= next(
        r for r in me["roles"] if r["role"] == "seller"
    ).items()
    merchant = (await client.get("/merchant")).json()
    assert merchant["status"] == "approved" and merchant["documents"][0]["status"] == "accepted"


# ── claims ───────────────────────────────────────────────────────────────────────────


async def test_two_sellers_cannot_claim_the_same_unit(clients, admin_client, monkeypatch):
    a = await approved_merchant(clients, admin_client, "seller_a")
    b = await approved_merchant(clients, admin_client, "seller_b")
    unit = (await free_units(a))[0]["code"]
    # Both claim at the same moment: the database lets exactly one win.
    ra, rb = await asyncio.gather(
        a.post("/merchant/claims", json={"unit_code": unit}),
        b.post("/merchant/claims", json={"unit_code": unit}),
    )
    assert sorted([ra.status_code, rb.status_code]) == [201, 409]
    loser = ra if ra.status_code == 409 else rb
    assert loser.json()["error"]["code"] == "UNIT_TAKEN"
    winner = ra if ra.status_code == 201 else rb
    assert winner.json()["status"] == "approved" and winner.json()["shop_id"]
    # Asking again later is refused too, and the map shows it as claimed.
    again = await (b if winner is ra else a).post("/merchant/claims", json={"unit_code": unit})
    assert again.status_code == 409
    assert (await a.get(f"/market/units/{unit}")).json()["status"] == "claimed"

    # Losing the race after the application's own check (only the database notices) is a
    # clean 409, not a server error.
    second = (await free_units(a))[0]["code"]
    assert (await a.post("/merchant/claims", json={"unit_code": second})).status_code == 201

    async def nobody(*_args, **_kwargs):
        return None

    monkeypatch.setattr(claims, "live_claim", nobody)
    late = await b.post("/merchant/claims", json={"unit_code": second})
    assert late.status_code == 409 and late.json()["error"]["code"] == "UNIT_TAKEN", late.text
    monkeypatch.undo()

    # The guarantee holds even if application checks were bypassed.
    async with SessionLocal() as session:
        prop = await session.scalar(select(VirtualProperty).where(VirtualProperty.code == unit))
        live = await session.scalar(
            select(PropertyClaim).where(PropertyClaim.property_id == prop.id)
        )
        session.add(
            PropertyClaim(property_id=prop.id, merchant_id=live.merchant_id, status="pending")
        )
        with pytest.raises(IntegrityError):
            await session.flush()


async def test_claim_limit_release_and_expiry(clients, admin_client, monkeypatch):
    monkeypatch.setattr(settings, "max_units_per_merchant", 2)
    seller = await approved_merchant(clients, admin_client, "limit_lee")
    units = [u["code"] for u in await free_units(seller, 3)]
    first = (await seller.post("/merchant/claims", json={"unit_code": units[0]})).json()
    assert (await seller.post("/merchant/claims", json={"unit_code": units[1]})).status_code == 201
    over = await seller.post("/merchant/claims", json={"unit_code": units[2]})
    assert over.status_code == 409 and over.json()["error"]["code"] == "CLAIM_LIMIT"

    assert (await seller.post(f"/merchant/claims/{first['id']}/release")).status_code == 200
    assert (await seller.get(f"/market/units/{units[0]}")).json()["status"] == "available"
    assert (await seller.post("/merchant/claims", json={"unit_code": units[2]})).status_code == 201

    # A claim past its term expires and its storefront closes.
    second = next(
        c for c in (await seller.get("/merchant/claims")).json() if c["unit"]["code"] == units[1]
    )
    async with SessionLocal() as session:
        await session.execute(
            update(PropertyClaim)
            .where(PropertyClaim.id == second["id"])
            .values(expires_at=utcnow() - timedelta(minutes=1))
        )
        await session.commit()
    async with SessionLocal() as session:
        assert await claims.expire_due(session) == 1
    assert (await seller.get(f"/market/units/{units[1]}")).json()["status"] == "available"
    statuses = {
        c["unit"]["code"]: c["status"] for c in (await seller.get("/merchant/claims")).json()
    }
    assert statuses[units[1]] == "expired" and statuses[units[0]] == "released"
    assert len((await seller.get("/merchant/shops")).json()) == 1


async def test_real_business_unit_needs_evidence_review_and_can_be_disputed(clients, admin_client):
    seller = await approved_merchant(clients, admin_client, "evidence_em")
    unit = (await free_units(seller, verification=True))[0]
    assert unit["real_business_name"]
    bare = await seller.post("/merchant/claims", json={"unit_code": unit["code"]})
    assert bare.status_code == 422 and bare.json()["error"]["code"] == "EVIDENCE_REQUIRED"

    doc = (
        await seller.post(
            "/merchant/documents",
            files={"file": ("lease.pdf", PDF, "application/pdf")},
            data={"kind": "lease_or_utility"},
        )
    ).json()
    claim = await seller.post(
        "/merchant/claims",
        json={"unit_code": unit["code"], "document_id": doc["id"], "evidence_note": "I own it"},
    )
    assert claim.status_code == 201 and claim.json()["status"] == "pending"
    assert not claim.json()["shop_id"]  # nothing appears in the city before review
    pending = (await admin_client.get("/admin/claims", params={"status": "pending"})).json()
    assert [c["id"] for c in pending] == [claim.json()["id"]] and pending[0]["document"]
    await admin_client.post(f"/admin/claims/{claim.json()['id']}/approve", json={})
    shops = (await seller.get("/market/shops")).json()
    assert [s["unit"]["code"] for s in shops] == [unit["code"]]

    # The real owner disputes; the administrator upholds; the claim and shop end.
    owner = await clients()
    await onboard(owner, "real_owner", roles=["buyer"])
    short = await owner.post("/market/disputes", json={"unit_code": unit["code"], "reason": "mine"})
    assert short.status_code == 422
    reason = "This is my family's shop at this address since 2009; I did not authorise this."
    opened = await owner.post(
        "/market/disputes", json={"unit_code": unit["code"], "reason": reason}
    )
    assert opened.status_code == 201, opened.text
    disputes = (await admin_client.get("/admin/disputes")).json()
    assert disputes[0]["claimed_by"] == "Evidence_Em Shop"
    resolved = await admin_client.post(
        f"/admin/disputes/{disputes[0]['id']}/resolve",
        json={"uphold": True, "note": "Owner verified"},
    )
    assert resolved.status_code == 200
    assert (await owner.get(f"/market/units/{unit['code']}")).json()["status"] == "available"
    assert (await owner.get("/market/shops")).json() == []
    mine = (await seller.get("/merchant/claims")).json()[0]
    assert mine["status"] == "revoked" and mine["decision_reason"] == "Owner verified"


async def test_transfer_moves_the_unit_to_another_merchant(clients, admin_client):
    a = await approved_merchant(clients, admin_client, "from_fay")
    b = await approved_merchant(clients, admin_client, "to_tom")
    unit = (await free_units(a))[0]["code"]
    claim = (await a.post("/merchant/claims", json={"unit_code": unit})).json()
    offer = await a.post(f"/merchant/claims/{claim['id']}/transfer", json={"to_username": "to_tom"})
    assert offer.status_code == 201
    dup = await a.post(f"/merchant/claims/{claim['id']}/transfer", json={"to_username": "to_tom"})
    assert dup.status_code == 409
    transfer = (await b.get("/merchant/transfers")).json()[0]
    assert transfer["direction"] == "incoming" and transfer["unit_code"] == unit
    assert (await a.post(f"/merchant/transfers/{transfer['id']}/accept")).status_code == 403
    assert (await b.post(f"/merchant/transfers/{transfer['id']}/accept")).status_code == 200
    assert (await a.get("/merchant/claims")).json()[0]["status"] == "transferred"
    new = (await b.get("/merchant/claims")).json()[0]
    assert new["status"] == "approved" and new["unit"]["code"] == unit
    assert new["expires_at"] == claim["expires_at"]  # the remaining term moves with the unit
    shops = (await b.get("/market/shops")).json()
    assert [(s["unit"]["code"], s["merchant_name"]) for s in shops] == [(unit, "To_Tom Shop")]


async def test_shop_floor_is_walkable_only_while_the_shop_exists(clients, admin_client):
    seller = await approved_merchant(clients, admin_client, "floor_fin")
    async with world_socket(seller) as ws:
        await expect(ws, "welcome")
        region_id = next(iter(hub._loaded))
        validator = hub._loaded[region_id].validator
        unit = (await free_units(seller))[0]["code"]
        async with SessionLocal() as session:
            prop = await session.scalar(select(VirtualProperty).where(VirtualProperty.code == unit))
        rect = Polygon(prop.corners)
        centre = rect.centroid
        assert validator.inside_obstacle(centre.x, centre.y)  # a wall, before the shop exists

        claim = (await seller.post("/merchant/claims", json={"unit_code": unit})).json()
        await expect(ws, "shops")  # clients are told to reload storefronts
        assert not validator.inside_obstacle(centre.x, centre.y)
        # Deeper in the same building (behind the shop's back wall) is still solid.
        back = (
            (prop.corners[2][0] + prop.corners[3][0]) / 2,
            (prop.corners[2][1] + prop.corners[3][1]) / 2,
        )
        bx = back[0] + math.sin(prop.heading) * -1.5
        bz = back[1] + math.cos(prop.heading) * -1.5
        async with SessionLocal() as session:
            inside_building = await session.scalar(
                text(
                    "SELECT ST_Contains(footprint, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)) "
                    "FROM buildings WHERE id = :b"
                ),
                dict(zip(("lat", "lon"), default_projection().to_latlon(bx, bz), strict=True))
                | {"b": prop.building_id},
            )
        if inside_building:
            assert validator.inside_obstacle(bx, bz)

        # The shop is a fast-travel destination: the pavement in front of its door, facing it.
        await send(ws, t="travel", shop=claim["shop_id"])
        arrived = await expect(ws, "teleport")
        assert math.hypot(arrived["x"] - prop.door_x, arrived["z"] - prop.door_z) < 4.5
        assert not validator.inside_obstacle(arrived["x"], arrived["z"])
        facing = math.atan2(
            math.sin(arrived["yaw"] - prop.heading), math.cos(arrived["yaw"] - prop.heading)
        )
        assert abs(abs(facing) - math.pi) < 0.01
        hub.by_user[next(iter(hub.by_user))].last_travel -= 5  # travel is rate limited
        await send(ws, t="travel", shop="00000000-0000-0000-0000-000000000000")
        assert (await expect(ws, "error"))["code"] == "UNKNOWN_PLACE"

        # Restocking tells clients too (they reload the shelves they can see).
        product = await seller.post(
            "/merchant/products", json={"name": "Num pang", "category": "food", "price_minor": 250}
        )
        assert product.status_code == 201
        await expect(ws, "shops")

        await seller.post(f"/merchant/claims/{claim['id']}/release")
        await expect(ws, "shops")
        assert validator.inside_obstacle(centre.x, centre.y)


async def test_image_upload_strips_metadata(clients, admin_client):
    from PIL import Image

    seller = await approved_merchant(clients, admin_client, "photo_pich")
    product = (
        await seller.post(
            "/merchant/products",
            json={"name": "Iced coffee", "category": "drinks", "price_minor": 150, "stock": 3},
        )
    ).json()
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"  # camera make
    exif.get_ifd(0x8825)[2] = (11.0, 34.0, 10.0)  # GPSLatitude: a phone photo's location
    buffer = io.BytesIO()
    Image.new("RGB", (1600, 900), "#a0522d").save(buffer, "JPEG", exif=exif.tobytes())
    assert b"Exif" in buffer.getvalue()
    response = await seller.post(
        f"/merchant/products/{product['id']}/image",
        files={"file": ("coffee.jpg", buffer.getvalue(), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    url = response.json()["image_url"]
    image = await seller.get(url.removeprefix("/api/v1"))
    assert image.status_code == 200 and image.headers["content-type"] == "image/webp"
    assert b"Exif" not in image.content and b"PhoneMaker" not in image.content
    with Image.open(io.BytesIO(image.content)) as stored:
        assert max(stored.size) == 768
    bogus = await seller.post(
        f"/merchant/products/{product['id']}/image",
        files={"file": ("x.jpg", b"GIF89a....", "image/jpeg")},
    )
    assert bogus.status_code == 400
    assert (await seller.get("/media/products/../../etc/passwd")).status_code == 404
