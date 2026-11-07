"""Private data must stay private: addresses, contact details and real-world locations."""

import json

import httpx
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import AuditLog
from tests.conftest import CENTRAL_MARKET, make_client, onboard


async def test_addresses_are_only_visible_to_their_owner(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    mine = (await client.get("/me/addresses")).json()
    assert len(mine) == 1
    async with make_client() as other:
        await onboard(other, "dara")
        assert len((await other.get("/me/addresses")).json()) == 1
        # Another user's address id behaves exactly like a missing one.
        r = await other.delete(f"/me/addresses/{mine[0]['id']}")
        assert r.status_code == 404
    assert len((await client.get("/me/addresses")).json()) == 1


async def test_public_player_card_has_no_private_data(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as viewer:
        await onboard(viewer, "dara")
        card = await viewer.get("/players/sokha")
    assert card.status_code == 200
    text = card.text.lower()
    for secret in ("sokha@example.com", "street 130", "lat", "lon", "phone", "email"):
        assert secret not in text, secret
    assert set(card.json()) == {"username", "display_name", "avatar", "badges", "member_since"}


async def test_hidden_players_are_not_discoverable(client: httpx.AsyncClient):
    await onboard(client, "hidden", visible=False)
    assert (await client.get("/players/hidden")).status_code == 200  # visible to themselves
    async with make_client() as viewer:
        await onboard(viewer, "dara")
        assert (await viewer.get("/players/hidden")).status_code == 404


async def test_me_does_not_embed_addresses(client: httpx.AsyncClient):
    me = await onboard(client)
    assert "addresses" not in me
    assert str(CENTRAL_MARKET[0]) not in json.dumps(me)


async def test_audit_log_never_stores_coordinates_or_address_text(client: httpx.AsyncClient):
    await onboard(client)
    async with SessionLocal() as session:
        entries = (await session.scalars(select(AuditLog))).all()
    blob = json.dumps([e.data for e in entries])
    assert "address.created" in {e.action for e in entries}
    assert "Street 130" not in blob and str(CENTRAL_MARKET[0]) not in blob
