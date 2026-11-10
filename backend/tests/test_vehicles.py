"""Phase 5: vehicles — the garage API, riding over the world socket (per-mode speed checks,
staying on roads), parking rules, auto-parking, and what other players see."""

import asyncio
import math
import re
import time
import uuid

import httpx
import pytest
from shapely.geometry import Point
from sqlalchemy import select, text

from app.core.database import SessionLocal
from app.models import Vehicle
from app.multiplayer.hub import hub
from app.transport import routing
from app.transport.specs import KERB_BAND_M, MODES, MOTORBIKE, PULL_OVER_M
from tests.conftest import expect, never, onboard, send, world_socket


def uid(me: dict) -> uuid.UUID:
    return uuid.UUID(me["id"])


async def region_id() -> uuid.UUID:
    async with SessionLocal() as session:
        return await session.scalar(
            text("SELECT id FROM geographic_regions WHERE slug = 'daun-penh-central'")
        )


async def graph() -> routing.RoadGraph:
    async with SessionLocal() as session:
        return await routing.load_graph(session, await region_id())


def stand_at(user_id: uuid.UUID, x: float, z: float, yaw: float = 0.0) -> None:
    """Put a connected player somewhere (as if they had walked there)."""
    player = hub.by_user[user_id]
    player.x, player.z, player.yaw = x, z, yaw
    player.room.place(player)
    player.dirty = True


def straight_road(g: routing.RoadGraph, x: float, z: float) -> int:
    """A straight motorbike road of 40 m or more near (x, z): index into g.edges."""
    best: tuple[float, int] | None = None
    for i, e in enumerate(g.edges):
        if not (e.fwd | e.bwd) & MOTORBIKE or e.length < 40:
            continue
        if math.dist(e.pts[0], e.pts[-1]) / e.length < 0.99:
            continue
        d = math.dist(e.pts[0], (x, z))
        if d < 200 and (best is None or d < best[0]):
            best = (d, i)
    assert best is not None
    return best[1]


# ── garage ──────────────────────────────────────────────────────────────────────────────


async def test_starter_vehicles_are_parked_legally_next_to_you(client: httpx.AsyncClient, clients):
    await onboard(client, "sokha")
    assert (await client.get("/vehicles")).json() == []
    created = await client.post("/vehicles", json={"kind": "motorbike", "color": "#C4552F"})
    assert created.status_code == 201, created.text
    moto = created.json()
    assert re.fullmatch(r"DW \d[A-Z]-\d{4}", moto["plate"])
    assert moto["status"] == "parked" and moto["color"] == "#c4552f"
    assert moto["street"]  # parked on a real street, by name
    again = await client.post("/vehicles", json={"kind": "motorbike"})
    assert again.status_code == 409 and again.json()["error"]["code"] == "VEHICLE_EXISTS"
    bike = (await client.post("/vehicles", json={"kind": "bicycle", "name": "Kong"})).json()
    assert bike["name"] == "Kong"
    assert (await client.post("/vehicles", json={"kind": "tuktuk"})).status_code == 422

    # Both stand where parking is allowed, not inside buildings, and apart.
    world = await hub.region_world(await region_id())
    for v in (moto, bike):
        assert world.area.parkable(MODES[v["kind"]].bit, v["x"], v["z"])
        assert not world.validator.inside_obstacle(v["x"], v["z"], open_zones=False)
    assert math.hypot(moto["x"] - bike["x"], moto["z"] - bike["z"]) >= 1.3

    renamed = await client.patch(
        f"/vehicles/{moto['id']}", json={"name": "Dream", "color": "#2f7d6d"}
    )
    assert renamed.json()["name"] == "Dream" and renamed.json()["color"] == "#2f7d6d"
    assert (await client.patch(f"/vehicles/{moto['id']}", json={"color": "red"})).status_code == 422

    # Other people's vehicles do not exist for you.
    other = await clients()
    await onboard(other, "dara")
    assert (await other.patch(f"/vehicles/{moto['id']}", json={"name": "Mine"})).status_code == 404
    assert (await other.delete(f"/vehicles/{moto['id']}")).status_code == 404
    assert (await other.get("/vehicles")).json() == []
    # The valet needs you in the world.
    summon = await client.post(f"/vehicles/{moto['id']}/summon")
    assert summon.status_code == 409 and summon.json()["error"]["code"] == "NOT_IN_WORLD"
    assert (await client.delete(f"/vehicles/{bike['id']}")).status_code == 204
    assert [v["kind"] for v in (await client.get("/vehicles")).json()] == ["motorbike"]


# ── riding ──────────────────────────────────────────────────────────────────────────────


async def test_riding_a_motorbike_is_validated_by_the_server(client: httpx.AsyncClient, clients):
    me = await onboard(client, "sokha")
    other = await clients()
    await onboard(other, "dara")
    async with world_socket(client) as ws, world_socket(other) as watcher:
        await expect(ws, "welcome")
        their_id = (await expect(watcher, "welcome"))["you"]["id"]
        my_sid = (await expect(watcher, "spawn"))["p"]["id"]
        moto = (await client.post("/vehicles", json={"kind": "motorbike"})).json()
        seen = await expect(ws, "vspawn", where=lambda m: m["v"]["id"] == moto["id"])
        assert seen["v"]["mine"] and seen["v"]["name"] == "My motorbike"
        theirs = await expect(watcher, "vspawn", where=lambda m: m["v"]["id"] == moto["id"])
        assert "mine" not in theirs["v"] and "name" not in theirs["v"]  # no owner identity

        # Too far away to get on; someone else's vehicle cannot be ridden at all.
        stand_at(uid(me), moto["x"] + 6, moto["z"])
        await send(ws, t="mount", v=moto["id"])
        assert (await expect(ws, "error"))["code"] == "TOO_FAR"
        await send(watcher, t="mount", v=moto["id"])
        assert (await expect(watcher, "error"))["code"] == "VEHICLE_NOT_FOUND"

        stand_at(uid(me), moto["x"] + 1.5, moto["z"])
        await send(ws, t="mount", v=moto["id"])
        ride = await expect(ws, "ride")
        assert ride["v"]["k"] == "motorbike" and (ride["x"], ride["z"]) == (moto["x"], moto["z"])
        seen_ride = await expect(watcher, "ride")
        assert seen_ride["id"] == my_sid and seen_ride["v"]["c"] == moto["color"]
        assert "x" not in seen_ride  # positions come with the normal state updates
        await expect(watcher, "vdespawn", where=lambda m: m["id"] == moto["id"])
        await send(ws, t="mount", v=moto["id"])
        assert (await expect(ws, "error"))["code"] == "ALREADY_RIDING"

        # Ride along a straight street nearby at 11 m/s (40 km/h): 5.5 m every 0.5 s.
        g = await graph()
        edge = straight_road(g, moto["x"], moto["z"])
        player = hub.by_user[uid(me)]
        x, z, _b = g.point_at(edge, 5.0)
        stand_at(uid(me), x, z)
        for k in range(1, 4):
            x, z, _b = g.point_at(edge, 5.0 + 5.5 * k)
            player.t_move = time.monotonic() - 0.5
            await send(ws, t="move", x=x, z=z, yaw=0, s=11)
            await asyncio.sleep(0.05)
        await never(ws, "correct", wait=0.3)
        assert math.hypot(player.x - x, player.z - z) < 0.01
        state = await expect(
            watcher, "state", where=lambda m: any(p[0] == my_sid and p[4] > 0 for p in m["p"])
        )
        assert next(p for p in state["p"] if p[0] == my_sid)[4] == 11  # speed travels too

        # On foot the same pace is impossible: get off, then try it.
        await send(ws, t="dismount")
        off = await expect(ws, "ride")
        assert off["v"] is None
        parked = await expect(ws, "vspawn", where=lambda m: m["v"]["id"] == moto["id"])
        world = await hub.region_world(await region_id())
        assert world.area.parkable(MOTORBIKE, parked["v"]["x"], parked["v"]["z"])
        assert math.hypot(off["x"] - parked["v"]["x"], off["z"] - parked["v"]["z"]) < 2
        x, z, _b = g.point_at(edge, 5.0)
        stand_at(uid(me), x, z)
        player.t_move = time.monotonic() - 0.5  # 9 m in 0.5 s: fine on a motorbike, not on foot
        far_x, far_z, _b = g.point_at(edge, 14.0)
        await send(ws, t="move", x=far_x, z=far_z, yaw=0, s=14)
        assert (await expect(ws, "correct"))["why"] == "speed"
        assert their_id  # the watcher stayed connected throughout

        async with SessionLocal() as session:
            row = await session.get(Vehicle, uuid.UUID(moto["id"]))
        assert row.status == "parked" and row.odometer_m >= 15
        assert (row.x, row.z) == pytest.approx((parked["v"]["x"], parked["v"]["z"]), abs=0.01)


async def test_vehicles_stay_on_roads_and_park_at_the_kerb(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        moto = (await client.post("/vehicles", json={"kind": "motorbike"})).json()
        stand_at(uid(me), moto["x"], moto["z"])
        await send(ws, t="mount", v=moto["id"])
        await expect(ws, "ride")
        world = await hub.region_world(await region_id())
        player = hub.by_user[uid(me)]

        # Off the road (open ground, not a building): refused for a vehicle.
        off_road = next(
            (x, z)
            for r in (4, 6, 8, 10, 12, 15, 20, 25, 30)
            for k in range(24)
            for x, z in [
                (
                    moto["x"] + r * math.cos(k * math.tau / 24),
                    moto["z"] + r * math.sin(k * math.tau / 24),
                )
            ]
            if not world.area.allows(MOTORBIKE, x, z)
            and not world.validator.inside_obstacle(x, z)
            and world.validator.in_bounds(x, z)
        )
        player.t_move -= 10
        await send(ws, t="move", x=off_road[0], z=off_road[1], yaw=0, s=5)
        assert (await expect(ws, "correct"))["why"] == "offroad"

        # The middle of Daun Penh's widest street: too far from any kerb to pull over.
        g = await graph()
        wide = max(
            (e for e in g.edges if e.highway in ("primary", "secondary", "tertiary")),
            key=lambda e: e.width,
        )
        assert wide.width / 2 - KERB_BAND_M > PULL_OVER_M
        mid_x, mid_z, _b = g.point_at(g.by_id[wide.id], wide.length / 2)
        stand_at(uid(me), mid_x, mid_z)
        await send(ws, t="dismount")
        error = await expect(ws, "error")
        assert error["code"] == "PARKING_NOT_ALLOWED"
        assert hub.by_user[uid(me)].riding is not None  # still riding

        # Near the kerb of a narrower through road: pulled over to the kerb band.
        kerb_road = next(
            e for e in g.edges if e.highway in ("primary", "secondary") and 9 <= e.width <= 14
        )
        cx, cz, _b = g.point_at(g.by_id[kerb_road.id], kerb_road.length / 2)
        stand_at(uid(me), cx, cz)
        ws.inbox.clear()  # only what follows this dismount
        await send(ws, t="dismount")
        off = await expect(ws, "ride")
        assert off["v"] is None
        spot = await expect(ws, "vspawn", where=lambda m: m["v"]["id"] == moto["id"])
        px, pz = spot["v"]["x"], spot["v"]["z"]
        assert world.area.parkable(MOTORBIKE, px, pz) and not world.area.in_carriageway_core(px, pz)
        assert math.hypot(px - cx, pz - cz) <= PULL_OVER_M + 0.1
        # Lined up at the kerb (0.6 m inside the carriageway edge), parallel to the street.
        e = g.edges[g.by_id[kerb_road.id]]
        assert e.line.distance(Point(px, pz)) == pytest.approx(kerb_road.width / 2 - 0.6, abs=0.15)
        _x, _z, bearing = g.point_at(g.by_id[kerb_road.id], kerb_road.length / 2)
        road_yaw = math.pi - math.radians(bearing)  # compass bearing → world yaw
        assert abs(math.sin(spot["v"]["yaw"] - road_yaw)) < 0.05


async def test_disconnecting_or_travelling_parks_the_vehicle(client: httpx.AsyncClient, clients):
    me = await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        bike = (await client.post("/vehicles", json={"kind": "bicycle"})).json()
        stand_at(uid(me), bike["x"], bike["z"])
        await send(ws, t="mount", v=bike["id"])
        await expect(ws, "ride")
        listed = (await client.get("/vehicles")).json()
        assert listed[0]["status"] == "in_use"
        assert (await client.delete(f"/vehicles/{bike['id']}")).status_code == 409
        await send(ws, t="travel", spawn="riverside")
        await expect(ws, "ride", where=lambda m: m["v"] is None)
        note = await expect(ws, "notify", where=lambda m: m["kind"] == "vehicle_parked")
        assert "bicycle" in note["text"]
        assert (await expect(ws, "teleport"))["x"] > 900
        world = await hub.region_world(await region_id())
        left = world.parked.by_id[bike["id"]]  # left behind, at a legal spot near the old place
        assert math.hypot(left.x - bike["x"], left.z - bike["z"]) < 31
        assert world.area.parkable(MODES["bicycle"].bit, left.x, left.z)

        # Valet: brought to the street next to you, once a minute.
        summoned = await client.post(f"/vehicles/{bike['id']}/summon")
        assert summoned.status_code == 200, summoned.text
        here = hub.by_user[uid(me)]
        nearest_road = (await graph()).snap(here.x, here.z, MODES["bicycle"].bit)[0].distance
        brought = math.hypot(summoned.json()["x"] - here.x, summoned.json()["z"] - here.z)
        assert brought <= max(25.0, nearest_road + 12.0) + 0.5
        await expect(ws, "vspawn", where=lambda m: m["v"]["id"] == bike["id"])
        again = await client.post(f"/vehicles/{bike['id']}/summon")
        assert again.status_code == 429

        b = summoned.json()
        stand_at(uid(me), b["x"], b["z"])
        await send(ws, t="mount", v=bike["id"])
        await expect(ws, "ride", where=lambda m: m["v"] is not None)
    # The socket closed while riding: the bicycle is parked, not lost.
    await asyncio.sleep(0.1)
    async with SessionLocal() as session:
        row = (await session.scalars(select(Vehicle))).one()
    assert row.status == "parked"
    assert math.hypot(row.x - b["x"], row.z - b["z"]) < 31
    world = await hub.region_world(await region_id())
    assert str(row.id) in world.parked.by_id


async def test_hidden_and_blocked_owners_leave_no_trace(client: httpx.AsyncClient, clients):
    await onboard(client, "sokha")
    ghost = await clients()
    await onboard(ghost, "ghost", visible=False)
    rude = await clients()
    await onboard(rude, "rude")
    async with world_socket(client) as ws, world_socket(ghost) as g, world_socket(rude) as r:
        for sock in (ws, g, r):
            await expect(sock, "welcome")
        hidden_bike = (await ghost.post("/vehicles", json={"kind": "bicycle"})).json()
        rude_bike = (await rude.post("/vehicles", json={"kind": "bicycle"})).json()
        await expect(g, "vspawn", where=lambda m: m["v"]["id"] == hidden_bike["id"])  # own
        await expect(ws, "vspawn", where=lambda m: m["v"]["id"] == rude_bike["id"])
        await never(ws, "vspawn", where=lambda m: m["v"]["id"] == hidden_bike["id"])
        assert (await client.post("/social/blocks/rude")).status_code in (200, 201, 204)
        await expect(ws, "vdespawn", where=lambda m: m["id"] == rude_bike["id"])
