"""Phase 3: friends, invites, blocks, mutes, direct messages, reports and moderation."""

import math

import httpx
from sqlalchemy import select

from app.core.database import SessionLocal
from app.models import AuditLog, Friendship, PlayerReport
from tests.conftest import (
    admin_client,  # noqa: F401  (fixture)
    expect,
    make_client,
    never,
    onboard,
    send,
    world_socket,
)


async def test_friend_request_flow_with_live_notifications(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(other) as b:
            await expect(b, "welcome")
            r = await client.post("/social/friends", json={"username": "dara"})
            assert r.status_code == 200 and r.json()["message"] == "Friend request sent"
            note = await expect(b, "notify", where=lambda m: m["kind"] == "friend_request")
            assert note["u"] == "sokha"
            pending = (await other.get("/social/friends")).json()
            assert pending[0]["status"] == "incoming" and pending[0]["online"] is False
            assert (
                await client.post("/social/friends", json={"username": "dara"})
            ).status_code == 409

            assert (await other.post("/social/friends/sokha/accept")).status_code == 200
            async with world_socket(client) as a:
                await expect(a, "welcome")
                online = await expect(b, "notify", where=lambda m: m["kind"] == "friend_online")
                assert online["u"] == "sokha"
                friends = (await other.get("/social/friends")).json()
                assert friends == [
                    {**friends[0], "username": "sokha", "status": "accepted", "online": True}
                ]
            offline = await expect(b, "notify", where=lambda m: m["kind"] == "friend_offline")
            assert offline["u"] == "sokha"

    async with SessionLocal() as session:
        assert len((await session.scalars(select(Friendship))).all()) == 1


async def test_mutual_requests_become_friends(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        await other.post("/social/friends", json={"username": "sokha"})
        r = await client.post("/social/friends", json={"username": "dara"})
        assert r.json()["message"] == "Friend added"
        assert (await client.post("/social/friends", json={"username": "sokha"})).status_code == 422
        assert (await client.delete("/social/friends/dara")).status_code == 200
        assert (await client.get("/social/friends")).json() == []


async def test_invite_a_friend_to_join_you(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        await client.post("/social/friends", json={"username": "dara"})
        await other.post("/social/friends/sokha/accept")
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await send(b, t="travel", spawn="riverside")
            await expect(b, "teleport")
            await send(a, t="invite", to="dara")
            await expect(a, "notify", where=lambda m: m["kind"] == "invite_sent")
            invite = await expect(b, "invite")
            assert invite["u"] == "sokha"
            await send(b, t="join", **{"from": "sokha"})
            arrived = await expect(b, "teleport")
            assert arrived["why"] == "join"
            sokha = next(p for p in (await _players()) if p.username == "sokha")
            assert math.hypot(arrived["x"] - sokha.x, arrived["z"] - sokha.z) < 10
            # An invite works once.
            await send(b, t="join", **{"from": "sokha"})
            assert (await expect(b, "error"))["code"] == "INVITE_EXPIRED"
            # Strangers cannot be invited.
            await send(a, t="invite", to="nobody")
            assert (await expect(a, "error"))["code"] == "NOT_AVAILABLE"


async def _players():
    from app.multiplayer.hub import hub

    return list(hub.by_user.values())


async def test_mute_hides_chat_but_not_the_player(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await expect(b, "spawn")
            assert (await other.post("/social/mutes/sokha")).status_code == 200
            await send(a, t="chat", ch="nearby", text="can you hear me?")
            await never(b, "chat")
            await never(b, "despawn")  # still visible
            assert (await other.get("/social/relations")).json() == {
                "blocked": [],
                "muted": ["sokha"],
            }
            await other.delete("/social/mutes/sokha")
            await send(a, t="chat", ch="nearby", text="now?")
            assert (await expect(b, "chat"))["text"] == "now?"


async def test_block_hides_both_ways_and_stops_contact(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        await client.post("/social/friends", json={"username": "dara"})
        await other.post("/social/friends/sokha/accept")
        async with world_socket(client) as a, world_socket(other) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await expect(a, "spawn")
            await expect(b, "spawn")
            assert (await other.post("/social/blocks/sokha")).status_code == 200
            await expect(a, "despawn")
            await expect(b, "despawn")
            await send(a, t="chat", ch="world", text="hello?")
            await never(b, "chat")
        # Friendship is gone and contact is refused without revealing the block.
        assert (await client.get("/social/friends")).json() == []
        assert (await client.post("/social/friends", json={"username": "dara"})).status_code == 404
        assert (await client.post("/social/messages/dara", json={"text": "hi"})).status_code == 404
        async with SessionLocal() as session:
            assert "social.blocked" in set((await session.scalars(select(AuditLog.action))).all())


async def test_direct_messages(client: httpx.AsyncClient):
    await onboard(client, "sokha")
    async with make_client() as other:
        await onboard(other, "dara")
        async with world_socket(other) as b:
            await expect(b, "welcome")
            r = await client.post("/social/messages/dara", json={"text": "Lunch at Phsar Thmei?"})
            assert r.status_code == 201
            live = await expect(b, "notify", where=lambda m: m["kind"] == "dm")
            assert live["u"] == "sokha" and live["text"] == "Lunch at Phsar Thmei?"
        await client.post("/social/messages/dara", json={"text": "12:30 at the dome"})
        inbox = (await other.get("/social/conversations")).json()
        assert inbox[0]["username"] == "sokha" and inbox[0]["unread"] == 2
        thread = (await other.get("/social/messages/sokha")).json()
        assert [m["text"] for m in thread] == ["Lunch at Phsar Thmei?", "12:30 at the dome"]
        assert all(not m["from_me"] for m in thread)
        assert (await other.get("/social/conversations")).json()[0]["unread"] == 0
        assert (await client.post("/social/messages/sokha", json={"text": "me"})).status_code == 422


async def test_hidden_players_do_not_show_as_online_to_friends(client: httpx.AsyncClient):
    await onboard(client, "sokha", visible=False)
    async with make_client() as other:
        await onboard(other, "dara")
        await client.post("/social/friends", json={"username": "dara"})
        await other.post("/social/friends/sokha/accept")
        async with world_socket(client) as a:
            await expect(a, "welcome")
            assert (await other.get("/social/friends")).json()[0]["online"] is False
            # Becoming visible takes effect immediately in the world.
            await client.patch("/me/profile", json={"world_visible": True})
            assert (await other.get("/social/friends")).json()[0]["online"] is True


async def test_reports_capture_context_and_moderation_applies_live(
    client: httpx.AsyncClient,
    admin_client: httpx.AsyncClient,  # noqa: F811
):
    await onboard(client, "troll")
    async with make_client() as victim:
        await onboard(victim, "dara")
        async with world_socket(client) as a, world_socket(victim) as b:
            await expect(a, "welcome")
            await expect(b, "welcome")
            await send(a, t="chat", ch="nearby", text="you are an idiot")
            await expect(b, "chat")
            r = await victim.post(
                "/social/reports",
                json={
                    "username": "troll",
                    "reason": "harassment",
                    "details": "Insults near the market",
                },
            )
            assert r.status_code == 201
            assert (
                await client.get("/admin/reports")
            ).status_code == 403  # players cannot moderate
            reports = (await admin_client.get("/admin/reports")).json()
            assert reports[0]["reported"] == "troll" and reports[0]["reporter"] == "dara"
            assert reports[0]["context"]["messages"][0]["text"] == "you are an idiot"

            r = await admin_client.post(
                f"/admin/reports/{reports[0]['id']}/resolve",
                json={"action": "chat_mute", "hours": 2, "note": "first warning"},
            )
            assert r.status_code == 200
            await expect(a, "notify", where=lambda m: m["kind"] == "moderation")
            await send(a, t="chat", ch="nearby", text="still here")
            assert (await expect(a, "error"))["code"] == "CHAT_MUTED"
            assert (
                await client.post("/social/messages/dara", json={"text": "x"})
            ).status_code == 403
            twice = await admin_client.post(
                f"/admin/reports/{reports[0]['id']}/resolve", json={"action": "dismiss"}
            )
            assert twice.status_code == 409

            # A second report → suspension disconnects the player and ends their login.
            await victim.post("/social/reports", json={"username": "troll", "reason": "hate"})
            open_report = (await admin_client.get("/admin/reports")).json()[0]
            await admin_client.post(
                f"/admin/reports/{open_report['id']}/resolve", json={"action": "suspend"}
            )
            assert (await expect(a, "kicked"))["why"] == "suspended"
        assert (await client.get("/auth/me")).status_code == 401
    async with SessionLocal() as session:
        statuses = (await session.scalars(select(PlayerReport.status))).all()
    assert sorted(statuses) == ["resolved", "resolved"]
