"""Work roles (seller, driver): registered at the System Office in the city, one at a time."""

import uuid

import httpx

from app.multiplayer.buildings import SYSTEM_OFFICE
from app.multiplayer.hub import hub
from tests.conftest import (
    MERCHANT,
    expect,
    onboard,
    register_verified,
    shop_with_products,
    world_socket,
)


def stand_at(user_id: uuid.UUID, at_office: bool) -> None:
    """Put the player (in the world) at the System Office's counter, or far from it."""
    player = hub.by_user[user_id]
    point = player.room.footprints[int(SYSTEM_OFFICE.split(":")[1])].representative_point()
    player.x, player.z = (point.x, point.y) if at_office else (point.x + 400, point.y)


def role(me: dict, name: str) -> str | None:
    return next((r["status"] for r in me["roles"] if r["role"] == name), None)


async def test_work_roles_are_registered_at_the_office_one_at_a_time(client: httpx.AsyncClient):
    me = await onboard(client, roles=["buyer"])
    uid = uuid.UUID(me["id"])
    # Not in the city at all: no.
    r = await client.post("/me/work-role", json={"role": "driver"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "AT_THE_OFFICE"
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        stand_at(uid, at_office=False)
        r = await client.post("/me/work-role", json={"role": "driver"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "AT_THE_OFFICE"

        stand_at(uid, at_office=True)
        r = await client.post("/me/work-role", json={"role": "driver", "note": "Own motorbike"})
        assert r.status_code == 200, r.text
        assert role(r.json(), "driver") == "pending"
        # One at a time.
        r = await client.post("/me/work-role", json={"role": "seller", "business": MERCHANT})
        assert r.status_code == 409 and r.json()["error"]["code"] == "ONE_WORK_ROLE"
        r = await client.post("/me/work-role", json={"role": "driver"})
        assert r.json()["error"]["code"] == "ALREADY_REGISTERED"

        # Leave it, then register the other one.
        me = (await client.post("/me/work-role/leave")).json()
        assert role(me, "driver") == "revoked"
        r = await client.post("/me/work-role", json={"role": "seller"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "BUSINESS_REQUIRED"
        r = await client.post("/me/work-role", json={"role": "seller", "business": MERCHANT})
        assert r.status_code == 200, r.text
        assert role(r.json(), "seller") == "pending"
        assert (await client.get("/merchant")).json()["status"] == "pending"

        # Leaving a seller application takes it off the administrators' queue.
        me = (await client.post("/me/work-role/leave")).json()
        assert role(me, "seller") == "revoked"
        merchant = (await client.get("/merchant")).json()
        assert merchant["status"] == "rejected"
        assert merchant["decision_reason"] == "Withdrawn by the applicant"
        r = await client.post("/me/work-role/leave")
        assert r.json()["error"]["code"] == "NO_WORK_ROLE"
        # And it can be sent again.
        r = await client.post("/me/work-role", json={"role": "seller", "business": MERCHANT})
        assert role(r.json(), "seller") == "pending"


async def test_a_seller_with_a_shop_spot_releases_it_before_leaving(clients, admin_client):
    c, _shop, _ = await shop_with_products(clients, admin_client, "noodles", [])
    uid = uuid.UUID((await c.get("/auth/me")).json()["id"])
    async with world_socket(c) as ws:
        await expect(ws, "welcome")
        stand_at(uid, at_office=True)
        r = await c.post("/me/work-role/leave")
        assert r.status_code == 409 and r.json()["error"]["code"] == "RELEASE_UNITS_FIRST"
        assert "seller" in (await c.get("/auth/me")).json()["active_roles"]


async def test_the_roles_api_also_allows_one_work_role(client: httpx.AsyncClient):
    await register_verified(client)
    r = await client.post("/me/roles", json={"roles": ["buyer", "seller", "driver"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ONE_WORK_ROLE"
