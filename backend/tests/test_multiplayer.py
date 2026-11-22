"""Phase 3: the world WebSocket, presence, interest management, movement validation, chat."""

import asyncio
import contextlib

import httpx
import pytest
from sqlalchemy import select, text

from app.core.database import SessionLocal
from app.models import ChatMessage, PlayerSession
from app.multiplayer.chatfilter import prepare
from app.multiplayer.hub import BUILDING_SETS_PER_SECOND, hub
from tests.conftest import (
    expect,
    make_client,
    never,
    onboard,
    register_verified,
    send,
    world_socket,
)


async def close_code(c: httpx.AsyncClient, origin: str | None = "http://localhost:5173") -> int:
    with pytest.raises(BaseException) as info:
        async with world_socket(c, origin=origin):
            pass
    exc = info.value
    while isinstance(exc, BaseExceptionGroup):
        exc = exc.exceptions[0]
    return exc.code


# ── connecting ──────────────────────────────────────────────────────────────────────────


async def test_connection_requires_origin_session_and_onboarding(client: httpx.AsyncClient):
    assert await close_code(client) == 4401  # not signed in
    await register_verified(client, "halfway")
    assert await close_code(client) == 4409  # onboarding not finished
    async with make_client() as done:
        await onboard(done, "sokha")
        assert await close_code(done, origin="https://evil.example") == 4403  # CSWSH
        assert await close_code(done, origin=None) == 4403
        async with world_socket(done) as ws:
            welcome = await expect(ws, "welcome")
    assert welcome["room"] == "daun-penh-central-1"
    assert welcome["you"]["u"] == "sokha"
    assert welcome["tick"] == 20


async def test_two_players_see_each_other_and_disconnect_cleanly(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(client) as a, world_socket(other) as b:
            ya = (await expect(a, "welcome"))["you"]["id"]
            yb = (await expect(b, "welcome"))["you"]["id"]
            seen_by_a = await expect(a, "spawn")
            seen_by_b = await expect(b, "spawn")
            assert seen_by_a["p"]["u"] == "dara" and seen_by_a["p"]["id"] == yb
            assert seen_by_b["p"]["u"] == "sokha" and seen_by_b["p"]["id"] == ya
            assert seen_by_b["p"]["av"]["hair_style"] == "short"  # avatar travels with the spawn
            assert "lat" not in str(seen_by_b)  # virtual positions only, never GPS

            # Movement is synchronised.
            x, z = seen_by_b["p"]["x"], seen_by_b["p"]["z"]
            await send(a, t="move", x=x + 1.0, z=z, yaw=1.2, s=2.6)
            state = await expect(b, "state", where=lambda m: any(p[0] == ya for p in m["p"]))
            moved = next(p for p in state["p"] if p[0] == ya)
            assert moved[1] == pytest.approx(x + 1.0) and moved[3] == pytest.approx(1.2)

        # a and b closed: nobody is left online and the sessions are closed with positions.
        await asyncio.sleep(0.1)
        assert hub.by_user == {}
        async with SessionLocal() as session:
            rows = (await session.scalars(select(PlayerSession))).all()
        assert len(rows) == 2
        assert all(r.disconnected_at is not None and r.last_x is not None for r in rows)


async def test_departure_is_broadcast(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(client) as a:
            await expect(a, "welcome")
            async with world_socket(other) as b:
                yb = (await expect(b, "welcome"))["you"]["id"]
                await expect(a, "spawn")
            gone = await expect(a, "despawn")
            assert gone["id"] == yb


async def test_hidden_players_are_never_broadcast(client: httpx.AsyncClient):
    await onboard(client, "watcher")
    async with make_client() as other:
        await onboard(other, "ghost", visible=False)
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await expect(b, "spawn")  # the hidden player still sees others
            await never(a, "spawn")  # ...but is never shown to them


async def test_a_second_connection_replaces_the_first(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with world_socket(client) as first:
        await expect(first, "welcome")
        async with world_socket(client) as second:
            await expect(second, "welcome")
            kicked = await expect(first, "kicked")
            assert kicked["why"] == "replaced"
            assert len(hub.by_user) == 1


# ── movement validation & interest management ───────────────────────────────────────────


async def test_server_rejects_teleports_and_leaving_the_region(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with world_socket(client) as ws:
        start = await expect(ws, "welcome")
        x, z = start["x"], start["z"]
        await send(ws, t="move", x=x + 300, z=z, yaw=0, s=6)  # far beyond running speed
        fix = await expect(ws, "correct")
        assert fix["why"] == "speed" and (fix["x"], fix["z"]) == (x, z)

        await send(ws, t="move", x=99999, z=z, yaw=0, s=6)  # absurd: rejected by the schema
        assert (await expect(ws, "error"))["code"] == "BAD_MESSAGE"
        hub.by_user[me_id(me)].t_move -= 3600  # even with time to get there...
        await send(ws, t="move", x=5000, z=z, yaw=0, s=6)  # ...this is outside the region
        assert (await expect(ws, "correct"))["why"] == "bounds"

        await send(ws, t="move", x=x + 1.5, z=z, yaw=0, s=2)  # a normal step is accepted
        await never(ws, "correct")


def me_id(me: dict):
    import uuid

    return uuid.UUID(me["id"])


async def test_far_players_are_outside_the_interest_area(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await expect(a, "spawn")
            await send(b, t="travel", spawn="riverside")  # ~1 km east
            moved = await expect(b, "teleport")
            assert moved["why"] == "travel" and moved["x"] > 900
            await expect(a, "despawn")
            await send(b, t="travel", spawn="central-market")  # too soon: rate limited
            assert (await expect(b, "error"))["code"] == "RATE_LIMITED"
            next(p for p in hub.by_user.values() if p.username == "dara").last_travel -= 5
            await send(b, t="travel", spawn="central-market")
            await expect(b, "teleport")
            back = await expect(a, "spawn")
            assert back["p"]["u"] == "dara"


async def test_protocol_errors_are_reported(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        await ws.send_text("not json")
        assert (await expect(ws, "error"))["code"] == "BAD_MESSAGE"
        await send(ws, t="move", x="east", z=0, yaw=0)
        assert (await expect(ws, "error"))["code"] == "BAD_MESSAGE"
        await ws.send_text('{"t":"chat","text":"' + "x" * 5000 + '"}')
        assert (await expect(ws, "error"))["message"] == "Message too large"
        await send(ws, t="ping", c=123.5)
        assert (await expect(ws, "pong"))["c"] == 123.5


# ── chat & emotes ───────────────────────────────────────────────────────────────────────


def test_chat_filter():
    assert prepare("  hello \x00 ‮ world  ") == ("hello world", False)
    assert prepare("what the fuck") == ("what the f***", True)
    assert prepare("សួស្តី​បង")[0] == "សួស្តី​បង"  # Khmer and its line-break hint survive
    assert len(prepare("a" * 1000)[0]) == 280
    assert prepare("‎‏")[0] == ""


async def test_nearby_and_world_chat(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as near, make_client() as far:
        await onboard(near, "dara")
        await onboard(far, "vanna")
        async with world_socket(client) as a, world_socket(near) as b, world_socket(far) as c:
            for ws in (a, b, c):
                await expect(ws, "welcome")
            await send(c, t="travel", spawn="riverside")
            await expect(c, "teleport")
            await asyncio.sleep(0.15)

            await send(a, t="chat", ch="nearby", text="Sous-dey! Meet at the dome?")
            heard = await expect(b, "chat")
            assert heard["u"] == "sokha" and heard["ch"] == "nearby"
            assert heard["text"] == "Sous-dey! Meet at the dome?"
            await expect(a, "chat")  # the sender sees their own message
            await never(c, "chat")  # 1 km away

            await send(a, t="chat", ch="world", text="damn shit traffic")
            shout = await expect(c, "chat")
            assert shout["ch"] == "world" and shout["text"] == "damn s*** traffic"

    async with SessionLocal() as session:
        rows = (await session.scalars(select(ChatMessage).order_by(ChatMessage.id))).all()
    assert [(r.channel, r.flagged) for r in rows] == [("nearby", False), ("world", True)]


async def test_chat_is_rate_limited(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        for i in range(7):
            await send(ws, t="chat", ch="nearby", text=f"message {i}")
        error = await expect(ws, "error")
        assert error["code"] == "RATE_LIMITED"


async def test_emotes_reach_nearby_players(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(client) as a, world_socket(other) as b:
            ya = (await expect(a, "welcome"))["you"]["id"]
            await expect(b, "welcome")
            await expect(b, "spawn")
            await send(a, t="emote", e="sampeah")
            got = await expect(b, "emote")
            assert got == {"t": "emote", "id": ya, "e": "sampeah"}
            await send(a, t="emote", e="moonwalk")
            assert (await expect(a, "error"))["code"] == "BAD_MESSAGE"


# ── sessions over time ──────────────────────────────────────────────────────────────────


async def test_signing_out_elsewhere_ends_the_world_session(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        assert (await client.post("/auth/logout")).status_code == 200
        await hub.persist_and_revalidate()
        assert (await expect(ws, "kicked"))["why"] == "session_ended"


async def test_reconnecting_resumes_where_you_left_off(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with world_socket(client) as ws:
        start = await expect(ws, "welcome")
        await send(ws, t="move", x=start["x"] + 1.8, z=start["z"], yaw=0, s=2)
        await asyncio.sleep(0.2)
    boot = (await client.get("/world/bootstrap")).json()
    assert boot["start"]["resumed"] is True
    assert boot["start"]["x"] == pytest.approx(start["x"] + 1.8)
    async with world_socket(client) as ws:
        again = await expect(ws, "welcome")
    assert again["x"] == pytest.approx(start["x"] + 1.8)


async def test_players_arriving_at_the_same_spawn_do_not_overlap(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as second, make_client() as third:
        await onboard(second, "dara")
        await onboard(third, "vanna")
        async with world_socket(client) as a, world_socket(second) as b, world_socket(third) as c:
            spots = [(m["x"], m["z"]) for m in [await expect(ws, "welcome") for ws in (a, b, c)]]
    for i, (x1, z1) in enumerate(spots):
        for x2, z2 in spots[i + 1 :]:
            assert ((x1 - x2) ** 2 + (z1 - z2) ** 2) ** 0.5 >= 1.2


def test_on_foot_buildings_can_be_entered_but_not_water_or_by_vehicle():
    from shapely.geometry import Polygon as P

    from app.multiplayer.validation import MovementValidator

    square = lambda x, z, s: P([(x, z), (x + s, z), (x + s, z + s), (x, z + s)])  # noqa: E731
    building, river = square(0, 0, 10), square(20, 0, 10)
    v = MovementValidator([building, river], (-100, -100, 100, 100), water=[river])
    assert v.check(-3, 5, 5, 5, dt=10).ok  # into a building, on foot
    assert v.check(-3, 5, 5, 5, dt=10, on_foot=False).reason == "blocked"  # not by vehicle
    assert v.check(15, 5, 25, 5, dt=10).reason == "blocked"  # nobody walks on water
    # Spawn and arrival spots still avoid footprints, except open shop floors.
    assert v.inside_obstacle(5, 5)
    v.set_open_zones([square(2, 2, 3)])
    assert not v.inside_obstacle(3, 3) and v.inside_obstacle(8, 8)


async def test_players_walk_into_buildings_but_not_into_the_river(client: httpx.AsyncClient):
    me = await onboard(client, "dara")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        async with SessionLocal() as session:
            bx, bz = (
                await session.execute(
                    text("""
                SELECT ST_X(ST_Transform(ST_PointOnSurface(footprint), 32648)) - 491403.0801141087,
                       1278957.2265911433 - ST_Y(ST_Transform(ST_PointOnSurface(footprint), 32648))
                FROM buildings WHERE ST_Area(footprint::geography) > 400
                ORDER BY footprint <-> ST_SetSRID(ST_MakePoint(104.92116, 11.56890), 4326) LIMIT 1
            """)
                )
            ).one()
            wx, wz = (
                await session.execute(
                    text("""
                SELECT ST_X(ST_Transform(ST_PointOnSurface(geom), 32648)) - 491403.0801141087,
                       1278957.2265911433 - ST_Y(ST_Transform(ST_PointOnSurface(geom), 32648))
                FROM land_areas WHERE kind = 'water' ORDER BY ST_Area(geom) DESC LIMIT 1
            """)
                )
            ).one()
        hub.by_user[me_id(me)].t_move -= 120
        await send(ws, t="move", x=bx, z=bz, yaw=0, s=2)  # into a building: fine on foot
        await never(ws, "correct")
        hub.by_user[me_id(me)].t_move -= 600
        await send(ws, t="move", x=wx, z=wz, yaw=0, s=2)  # into the river: no
        assert (await expect(ws, "correct"))["why"] == "blocked"


# ── shared building state (doors, windows, lights, appliances) and storeys ────────────


def nearest_building(player) -> tuple[str, float]:
    """The id ("osm:<id>") of the building nearest a server-side player, and its distance."""
    from shapely.geometry import Point

    here = Point(player.x, player.z)
    bid, footprint = min(player.room.footprints.items(), key=lambda kv: kv[1].distance(here))
    return f"osm:{bid}", footprint.distance(here)


async def test_doors_and_lights_are_shared_with_players_around(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with make_client() as other, make_client() as late:
        await onboard(other, "dara")
        await onboard(late, "vanna")
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await expect(b, "spawn")
            player = hub.by_user[me_id(me)]
            building, distance = nearest_building(player)
            assert distance < 15, "the spawn should be at a building"
            # Nothing changed yet: every client keeps its defaults.
            await send(b, t="bget", b=building)
            assert (await expect(b, "bstate")) == {
                "t": "bstate",
                "b": building,
                "s": {},
                "all": True,
            }

            await send(a, t="bset", b=building, k="door", id="front", on=True)
            mine = await expect(a, "bstate")
            assert mine == {"t": "bstate", "b": building, "s": {"door:front": True}, "mine": True}
            seen = await expect(b, "bstate")
            assert seen == {"t": "bstate", "b": building, "s": {"door:front": True}}
            await send(a, t="bset", b=building, k="light", id="living", on=False)
            await send(a, t="bset", b=building, k="app", id="tv", on=True)
            await send(a, t="bset", b=building, k="door", id="window-0", on=True)
            for _ in range(3):
                await expect(b, "bstate")

            # Someone arriving later loads the building and gets what was changed.
            async with world_socket(late) as c:
                await expect(c, "welcome")
                await send(c, t="bget", b=building)
                got = await expect(c, "bstate")
            assert got["all"] is True
            assert got["s"] == {
                "door:front": True,
                "light:living": False,
                "app:tv": True,
                "door:window-0": True,
            }


async def test_building_changes_need_the_player_at_the_building(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        player = hub.by_user[me_id(me)]
        building, _ = nearest_building(player)
        # Far from it: ignored (the change is not kept either).
        x, z = player.x, player.z
        player.x += 400
        await send(ws, t="bset", b=building, k="door", id="front", on=True)
        await never(ws, "bstate")
        player.x = x
        await send(ws, t="bget", b=building)
        assert (await expect(ws, "bstate"))["s"] == {}
        # A building this region does not have, and the model house from across the city.
        await send(ws, t="bset", b="osm:999999999999", k="door", id="front", on=True)
        await send(ws, t="bset", b="riverside-house", k="door", id="front", on=True)
        await never(ws, "bstate")
        # At the model house: fine.
        player.x, player.z = 1005.0, -62.0
        await send(ws, t="bset", b="riverside-house", k="door", id="front", on=True)
        assert (await expect(ws, "bstate"))["s"] == {"door:front": True}
        player.x, player.z = x, z
        # Malformed: not a building id, not a kind of thing, not a part id.
        for bad in (
            {"b": "../etc", "k": "door", "id": "front", "on": True},
            {"b": building, "k": "fire", "id": "front", "on": True},
            {"b": building, "k": "door", "id": "front door!", "on": True},
            {"b": building, "k": "door", "id": "front", "on": "yes please"},
        ):
            await send(ws, t="bset", **bad)
            assert (await expect(ws, "error"))["code"] == "BAD_MESSAGE"
        # A few switches a second at most.
        player.building_sets.clear()
        for i in range(12):
            await send(ws, t="bset", b=building, k="light", id="living", on=i % 2 == 0)
        got = 0
        with contextlib.suppress(AssertionError):
            while True:
                await expect(ws, "bstate", timeout=0.5)
                got += 1
        assert got == BUILDING_SETS_PER_SECOND


def test_building_state_is_bounded():
    from app.multiplayer import buildings as B

    states = B.BuildingStates()
    for i in range(B.MAX_KEYS_PER_BUILDING):
        assert states.set("osm:1", f"door:d{i}", True)
    assert not states.set("osm:1", "door:one-too-many", True)
    assert states.set("osm:1", "door:d0", False)  # changing a known one is fine
    for i in range(B.MAX_BUILDINGS_PER_ROOM + 5):
        states.set(f"osm:{i + 2}", "door:front", True)
    assert len(states) == B.MAX_BUILDINGS_PER_ROOM
    assert states.get("osm:1") == {}  # the least recently changed went first
    assert states.get(f"osm:{B.MAX_BUILDINGS_PER_ROOM + 6}") == {"door:front": True}


async def test_others_see_which_storey_you_are_on(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with make_client() as other, make_client() as late:
        await onboard(other, "dara")
        await onboard(late, "vanna")
        async with world_socket(client) as a, world_socket(other) as b:
            ya = (await expect(a, "welcome"))["you"]["id"]
            await expect(b, "welcome")
            seen = await expect(b, "spawn")
            assert "l" not in seen["p"]
            player = hub.by_user[me_id(me)]
            x, z = player.x, player.z
            hub.by_user[me_id(me)].t_move -= 2
            await send(a, t="move", x=x + 0.5, z=z, yaw=0.0, s=1.0, l=1)
            up = await expect(b, "state", where=lambda m: any(p[0] == ya for p in m["p"]))
            assert next(p for p in up["p"] if p[0] == ya)[5] == 1
            async with world_socket(late) as c:
                await expect(c, "welcome")
                card = await expect(c, "spawn", where=lambda m: m["p"]["id"] == ya)
                assert card["p"]["l"] == 1
            hub.by_user[me_id(me)].t_move -= 2
            await send(a, t="move", x=x + 1.0, z=z, yaw=0.0, s=1.0)  # no l: the ground floor
            down = await expect(b, "state", where=lambda m: any(p[0] == ya for p in m["p"]))
            assert len(next(p for p in down["p"] if p[0] == ya)) == 5
            await send(a, t="move", x=x + 1.0, z=z, yaw=0.0, s=1.0, l=10)
            assert (await expect(a, "error"))["code"] == "BAD_MESSAGE"


async def test_buildings_go_back_to_default_when_everyone_has_left(client: httpx.AsyncClient):
    me = await onboard(client, "sokha")
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        building, _ = nearest_building(hub.by_user[me_id(me)])
        await send(ws, t="bset", b=building, k="door", id="front", on=True)
        await expect(ws, "bstate")
    await asyncio.sleep(0.1)
    async with world_socket(client) as ws:
        await expect(ws, "welcome")
        await send(ws, t="bget", b=building)
        assert (await expect(ws, "bstate"))["s"] == {}
