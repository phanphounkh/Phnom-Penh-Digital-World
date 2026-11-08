"""Phase 3: the world WebSocket, presence, interest management, movement validation, chat."""

import asyncio

import httpx
import pytest
from sqlalchemy import select, text

from app.core.database import SessionLocal
from app.models import ChatMessage, PlayerSession
from app.multiplayer.chatfilter import prepare
from app.multiplayer.hub import hub
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


async def test_server_rejects_teleports_walls_and_bounds(client: httpx.AsyncClient):
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

        # Into the middle of a building footprint (time pretends to allow the distance).
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
        hub.by_user[me_id(me)].t_move -= 120
        await send(ws, t="move", x=bx, z=bz, yaw=0, s=6)
        assert (await expect(ws, "correct"))["why"] == "blocked"

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
