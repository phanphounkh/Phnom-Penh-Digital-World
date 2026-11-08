"""The authoritative world hub: rooms, presence, interest management, chat and emotes.

One process owns all rooms (see docs/HLD.md). Every connected player has a send queue drained
by its own writer task, so a slow client cannot stall the room. A tick loop (WORLD_TICK_HZ)
diffs each player's visible set (3x3 chunk cells around them, minus hidden and blocked
players) and sends spawns, despawns and changed positions only.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import WebSocket
from pydantic import ValidationError
from shapely.geometry import Polygon
from sqlalchemy import select, text, update

from app.core.config import settings
from app.core.database import SessionLocal
from app.geography.projection import default_projection
from app.models import ChatMessage, GeographicRegion, PlayerSession, WorldRoom
from app.multiplayer import chatfilter
from app.multiplayer.protocol import (
    MAX_MESSAGE_BYTES,
    NEARBY_CHAT_RADIUS_M,
    Chat,
    Emote,
    Invite,
    Join,
    Move,
    Ping,
    Travel,
    client_message,
)
from app.multiplayer.validation import MovementValidator
from app.utils.time import utcnow

logger = logging.getLogger("ppw.hub")

QUEUE_LIMIT = 512
INVITE_TTL_S = 300
CHAT_WINDOW_S, CHAT_MAX = 10.0, 6
WORLD_CHAT_GAP_S = 4.0
EMOTE_GAP_S = 1.0
TRAVEL_GAP_S = 2.0
MOVES_PER_SECOND = 25
MAX_INVALID = 30


def yaw_for_heading(deg: float) -> float:
    return math.pi - math.radians(deg)


@dataclass(eq=False)
class Player:
    sid: int
    user_id: uuid.UUID
    username: str
    display_name: str
    avatar: dict[str, Any]
    visible: bool
    room: Room
    ws: WebSocket | None
    auth_session_id: uuid.UUID | None
    session_row_id: uuid.UUID | None
    x: float
    z: float
    yaw: float
    s: float = 0.0
    t_move: float = field(default_factory=time.monotonic)
    dirty: bool = True
    cell: tuple[int, int] = (0, 0)
    known: set[int] = field(default_factory=set)
    blocked: set[uuid.UUID] = field(default_factory=set)
    muted: set[uuid.UUID] = field(default_factory=set)
    friends: set[uuid.UUID] = field(default_factory=set)
    chat_muted_until: datetime | None = None
    invites: dict[uuid.UUID, float] = field(default_factory=dict)
    chat_times: deque[float] = field(default_factory=deque)
    move_times: deque[float] = field(default_factory=deque)
    last_world_chat: float = 0.0
    last_emote: float = 0.0
    last_travel: float = 0.0
    invalid: int = 0
    queue: asyncio.Queue[str | None] = field(default_factory=lambda: asyncio.Queue(QUEUE_LIMIT))
    writer: asyncio.Task[None] | None = None
    closing: bool = False

    def card(self) -> dict[str, Any]:
        return {
            "id": self.sid,
            "u": self.username,
            "n": self.display_name,
            "av": self.avatar,
            "x": round(self.x, 2),
            "z": round(self.z, 2),
            "yaw": round(self.yaw, 3),
        }

    def state(self) -> list[float]:
        return [self.sid, round(self.x, 2), round(self.z, 2), round(self.yaw, 3), round(self.s, 2)]


@dataclass(eq=False)
class Room:
    id: uuid.UUID
    slug: str
    region_id: uuid.UUID
    region_slug: str
    capacity: int
    validator: MovementValidator
    spawns: dict[str, tuple[float, float, float]]
    players: dict[int, Player] = field(default_factory=dict)
    cells: dict[tuple[int, int], set[int]] = field(default_factory=dict)

    def place(self, player: Player) -> None:
        cell = default_projection().chunk_of(player.x, player.z)
        if cell != player.cell or player.sid not in self.cells.get(cell, ()):
            self.cells.get(player.cell, set()).discard(player.sid)
            self.cells.setdefault(cell, set()).add(player.sid)
            player.cell = cell

    def remove(self, player: Player) -> None:
        self.players.pop(player.sid, None)
        self.cells.get(player.cell, set()).discard(player.sid)

    def around(self, cell: tuple[int, int]) -> list[Player]:
        ix, iz = cell
        out: list[Player] = []
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for sid in self.cells.get((ix + dx, iz + dz), ()):
                    p = self.players.get(sid)
                    if p is not None:
                        out.append(p)
        return out


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[uuid.UUID, Room] = {}
        self.by_user: dict[uuid.UUID, Player] = {}
        self._sid = 0
        self._task: asyncio.Task[None] | None = None
        self._loaded: dict[uuid.UUID, Room] = {}  # region_id → first room template
        self._lock = asyncio.Lock()

    # ── lifecycle ───────────────────────────────────────────────────────────────────────
    async def ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="world-hub")

    async def reset(self) -> None:
        """Drop all state (tests)."""
        for player in list(self.by_user.values()):
            await self._stop_writer(player)
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        self.__init__()

    async def _loop(self) -> None:
        period = 1 / max(1, settings.world_tick_hz)
        last_online = last_persist = time.monotonic()
        while True:
            await asyncio.sleep(period)
            try:
                self.tick()
                now = time.monotonic()
                if now - last_online >= 5:
                    last_online = now
                    for room in self.rooms.values():
                        msg = {
                            "t": "online",
                            "n": sum(1 for p in room.players.values() if p.visible),
                        }
                        for p in room.players.values():
                            self.send(p, msg)
                if now - last_persist >= settings.world_persist_seconds:
                    last_persist = now
                    await self.persist_and_revalidate()
            except Exception:
                logger.exception("Hub tick failed")

    # ── rooms ───────────────────────────────────────────────────────────────────────────
    async def _room_for(self, region_slug: str) -> Room:
        async with self._lock:
            candidates = [r for r in self.rooms.values() if r.region_slug == region_slug]
            for room in sorted(candidates, key=lambda r: r.slug):
                if len(room.players) < room.capacity:
                    return room
            return await self._open_room(region_slug, len(candidates) + 1)

    async def _open_room(self, region_slug: str, number: int) -> Room:
        async with SessionLocal() as session:
            region = (
                await session.execute(
                    select(GeographicRegion).where(GeographicRegion.slug == region_slug)
                )
            ).scalar_one()
            slug = f"{region_slug}-{number}"
            row = await session.scalar(select(WorldRoom).where(WorldRoom.slug == slug))
            if row is None:
                row = WorldRoom(
                    region_id=region.id,
                    slug=slug,
                    name=f"{region.name} · Room {number}",
                    capacity=settings.world_room_capacity,
                )
                session.add(row)
                await session.commit()
            template = self._loaded.get(region.id)
            if template is None:
                template = await self._load_world(session, region)
                self._loaded[region.id] = template
        room = Room(
            id=row.id,
            slug=row.slug,
            region_id=region.id,
            region_slug=region_slug,
            capacity=row.capacity,
            validator=template.validator,
            spawns=template.spawns,
        )
        self.rooms[room.id] = room
        logger.info("Opened world room %s", room.slug)
        return room

    async def _load_world(self, session: Any, region: GeographicRegion) -> Room:
        """Obstacles (footprints, water) and spawn points of a region, in world metres."""
        projection = default_projection()
        rows = await session.execute(
            text("""
            SELECT ST_AsBinary(footprint) AS g FROM buildings WHERE region_id = :r
            UNION ALL
            SELECT ST_AsBinary(geom) FROM land_areas WHERE region_id = :r AND kind = 'water'
        """),
            {"r": region.id},
        )
        from shapely import wkb

        polygons: list[Polygon] = []
        for row in rows:
            geom = projection.geometry_to_world(wkb.loads(bytes(row.g)))
            polygons.extend(g for g in getattr(geom, "geoms", [geom]) if isinstance(g, Polygon))
        bbox = (
            await session.execute(
                text("""
            SELECT ST_XMin(boundary) w, ST_YMin(boundary) s,
                   ST_XMax(boundary) e, ST_YMax(boundary) n
            FROM geographic_regions WHERE id = :r"""),
                {"r": region.id},
            )
        ).one()
        corners = [
            projection.to_world(lat, lon) for lat in (bbox.s, bbox.n) for lon in (bbox.w, bbox.e)
        ]
        xs, zs = [c[0] for c in corners], [c[1] for c in corners]
        bounds = (min(xs) + 3, min(zs) + 3, max(xs) - 3, max(zs) - 3)
        spawns: dict[str, tuple[float, float, float]] = {}
        for sp in await session.execute(
            text("""
            SELECT slug, ST_Y(location) lat, ST_X(location) lon, heading_deg
            FROM player_spawn_points WHERE region_id = :r AND is_active"""),
            {"r": region.id},
        ):
            x, z = projection.to_world(sp.lat, sp.lon)
            spawns[sp.slug] = (x, z, yaw_for_heading(sp.heading_deg))
        validator = MovementValidator(polygons, bounds)
        validator.set_open_zones(await self._shop_zones(session, region.id))
        return Room(
            id=uuid.uuid4(),
            slug="template",
            region_id=region.id,
            region_slug=region.slug,
            capacity=0,
            validator=validator,
            spawns=spawns,
        )

    @staticmethod
    async def _shop_zones(session: Any, region_id: uuid.UUID) -> list[Polygon]:
        """Floors of the region's active walk-in shops (world metres)."""
        rows = await session.execute(
            text("""
            SELECT vp.corners FROM shops s
            JOIN virtual_properties vp ON vp.id = s.property_id
            JOIN merchants m ON m.id = s.merchant_id
            WHERE s.status = 'active' AND m.status = 'approved' AND vp.region_id = :r"""),
            {"r": region_id},
        )
        return [Polygon(row.corners) for row in rows]

    async def shops_changed(self) -> None:
        """A storefront opened, closed, changed or ended: refresh movement validation and tell
        every connected client to reload the storefronts."""
        if self._loaded:
            async with SessionLocal() as session:
                for region_id, template in self._loaded.items():
                    template.validator.set_open_zones(await self._shop_zones(session, region_id))
        message = {"t": "shops"}
        for player in list(self.by_user.values()):
            self.send(player, message)

    def _arrival_spot(
        self, room: Room, x: float, z: float, seed: int, exclude: Player | None = None
    ):
        """Open ground at (or next to) a spawn point, not on top of another player."""
        others = [(p.x, p.z) for p in room.players.values() if p is not exclude]
        return room.validator.free_spot_near(
            x, z, radius=1.4, others=others, exact_ok=True, start_angle=seed * 2.399963
        )  # golden angle

    # ── presence ────────────────────────────────────────────────────────────────────────
    def is_online(self, user_id: uuid.UUID) -> bool:
        p = self.by_user.get(user_id)
        return p is not None and p.visible

    async def join(
        self,
        ws: WebSocket | None,
        *,
        user_id: uuid.UUID,
        username: str,
        display_name: str,
        avatar: dict[str, Any],
        visible: bool,
        region_slug: str,
        x: float,
        z: float,
        yaw: float,
        auth_session_id: uuid.UUID | None,
        relations: dict[str, set[uuid.UUID]],
        chat_muted_until: datetime | None,
        ip: str | None = None,
        user_agent: str | None = None,
    ) -> Player:
        await self.ensure_started()
        previous = self.by_user.get(user_id)
        if previous is not None:  # one world connection per account: the newest wins
            await self.kick(previous, "replaced")
        room = await self._room_for(region_slug)
        self._sid += 1
        x, z = self._arrival_spot(room, x, z, self._sid)
        player = Player(
            sid=self._sid,
            user_id=user_id,
            username=username,
            display_name=display_name,
            avatar=avatar,
            visible=visible,
            room=room,
            ws=ws,
            auth_session_id=auth_session_id,
            session_row_id=None,
            x=x,
            z=z,
            yaw=yaw,
            blocked=relations.get("blocked", set()),
            muted=relations.get("muted", set()),
            friends=relations.get("friends", set()),
            chat_muted_until=chat_muted_until,
        )
        # Choose the spot and register in one synchronous step (no await in between), so
        # players connecting at the same moment never pick the same spot.
        room.players[player.sid] = player
        room.place(player)
        self.by_user[user_id] = player
        now = utcnow()
        try:
            async with SessionLocal() as session:
                row = PlayerSession(
                    id=uuid.uuid4(),
                    user_id=user_id,
                    room_id=room.id,
                    auth_session_id=auth_session_id,
                    connected_at=now,
                    last_seen_at=now,
                    last_x=x,
                    last_z=z,
                    ip_address=ip,
                    user_agent=(user_agent or "")[:255] or None,
                )
                session.add(row)
                await session.commit()
                player.session_row_id = row.id
        except Exception:
            room.remove(player)
            self.by_user.pop(user_id, None)
            raise
        if ws is not None:
            player.writer = asyncio.create_task(self._write(player), name=f"ws-writer-{player.sid}")
        self.send(
            player,
            {
                "t": "welcome",
                "room": room.slug,
                "tick": settings.world_tick_hz,
                "you": {"id": player.sid, "u": username, "n": display_name, "visible": visible},
                "x": round(x, 2),
                "z": round(z, 2),
                "yaw": round(yaw, 3),
                "online": sum(1 for p in room.players.values() if p.visible),
            },
        )
        self._notify_friends(player, online=True)
        return player

    async def leave(self, player: Player, reason: str = "left") -> None:
        if self.by_user.get(player.user_id) is player:
            del self.by_user[player.user_id]
        room = player.room
        if room.players.get(player.sid) is player:
            room.remove(player)
            for other in room.players.values():
                if player.sid in other.known:
                    other.known.discard(player.sid)
                    self.send(other, {"t": "despawn", "id": player.sid, "why": "left"})
            self._notify_friends(player, online=False)
        await self._stop_writer(player)
        if player.session_row_id:
            async with SessionLocal() as session:
                await session.execute(
                    update(PlayerSession)
                    .where(
                        PlayerSession.id == player.session_row_id,
                        PlayerSession.disconnected_at.is_(None),
                    )
                    .values(
                        disconnected_at=utcnow(),
                        disconnect_reason=reason[:32],
                        last_x=player.x,
                        last_z=player.z,
                        last_seen_at=utcnow(),
                    )
                )
                await session.commit()

    async def kick(self, player: Player, reason: str) -> None:
        self.send(player, {"t": "kicked", "why": reason})
        player.closing = True
        await self.leave(player, reason)
        if player.ws is not None:
            with contextlib.suppress(Exception):
                await player.ws.close(code=4000 + {"replaced": 9, "suspended": 3}.get(reason, 1))

    async def kick_user(self, user_id: uuid.UUID, reason: str) -> None:
        player = self.by_user.get(user_id)
        if player:
            await self.kick(player, reason)

    # ── sending ─────────────────────────────────────────────────────────────────────────
    def send(self, player: Player, message: dict[str, Any]) -> None:
        if player.closing:
            return
        try:
            player.queue.put_nowait(json.dumps(message, separators=(",", ":"), ensure_ascii=False))
        except asyncio.QueueFull:
            logger.warning("Dropping slow client %s", player.username)
            player.closing = True
            asyncio.get_running_loop().create_task(self.leave(player, "slow"))

    async def _write(self, player: Player) -> None:
        assert player.ws is not None
        try:
            while True:
                data = await player.queue.get()
                if data is None:
                    return
                await player.ws.send_text(data)
        except Exception:  # socket closed under us; the reader loop handles the leave
            return

    async def _stop_writer(self, player: Player) -> None:
        if player.writer and not player.writer.done():
            # Flush what is queued (e.g. "kicked"), then stop.
            with contextlib.suppress(asyncio.QueueFull):
                player.queue.put_nowait(None)
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                await asyncio.wait_for(asyncio.shield(player.writer), timeout=1)
            player.writer.cancel()

    def notify_user(self, user_id: uuid.UUID, message: dict[str, Any]) -> bool:
        player = self.by_user.get(user_id)
        if player is None:
            return False
        self.send(player, message)
        return True

    def _notify_friends(self, player: Player, online: bool) -> None:
        if not player.visible:
            return  # hidden players do not broadcast presence, even to friends
        for friend_id in player.friends:
            friend = self.by_user.get(friend_id)
            if friend is not None and player.user_id not in friend.blocked:
                self.send(
                    friend,
                    {
                        "t": "notify",
                        "kind": "friend_online" if online else "friend_offline",
                        "u": player.username,
                        "n": player.display_name,
                    },
                )

    # ── interest management ─────────────────────────────────────────────────────────────
    @staticmethod
    def can_see(viewer: Player, other: Player) -> bool:
        return (
            other is not viewer
            and other.visible
            and other.user_id not in viewer.blocked
            and viewer.user_id not in other.blocked
        )

    def tick(self) -> None:
        now_ms = int(time.time() * 1000)
        for room in self.rooms.values():
            for viewer in list(room.players.values()):
                wanted = {p.sid: p for p in room.around(viewer.cell) if self.can_see(viewer, p)}
                for sid in viewer.known - wanted.keys():
                    self.send(viewer, {"t": "despawn", "id": sid, "why": "away"})
                fresh = [p for sid, p in wanted.items() if sid not in viewer.known]
                for p in fresh:
                    self.send(viewer, {"t": "spawn", "p": p.card()})
                moved = [p.state() for sid, p in wanted.items() if sid in viewer.known and p.dirty]
                if moved:
                    self.send(viewer, {"t": "state", "ts": now_ms, "p": moved})
                viewer.known = set(wanted)
            for p in room.players.values():
                p.dirty = False

    # ── messages ────────────────────────────────────────────────────────────────────────
    def _error(self, player: Player, code: str, message: str) -> None:
        self.send(player, {"t": "error", "code": code, "message": message})

    async def handle(self, player: Player, raw: str) -> None:
        if len(raw.encode()) > MAX_MESSAGE_BYTES:
            return await self._invalid(player, "Message too large")
        try:
            msg = client_message.validate_json(raw)
        except ValidationError:
            return await self._invalid(player, "Malformed message")
        match msg:
            case Move():
                self._move(player, msg)
            case Chat():
                await self._chat(player, msg)
            case Emote():
                self._emote(player, msg)
            case Travel():
                self._travel(player, msg)
            case Invite():
                self._invite(player, msg)
            case Join():
                self._join(player, msg)
            case Ping():
                self.send(player, {"t": "pong", "c": msg.c, "s": int(time.time() * 1000)})

    async def _invalid(self, player: Player, message: str) -> None:
        player.invalid += 1
        self._error(player, "BAD_MESSAGE", message)
        if player.invalid > MAX_INVALID:
            await self.kick(player, "protocol")

    def _move(self, player: Player, msg: Move) -> None:
        now = time.monotonic()
        while player.move_times and player.move_times[0] < now - 1:
            player.move_times.popleft()
        if len(player.move_times) >= MOVES_PER_SECOND:
            return
        player.move_times.append(now)
        verdict = player.room.validator.check(player.x, player.z, msg.x, msg.z, now - player.t_move)
        if not verdict.ok:
            self.send(
                player,
                {
                    "t": "correct",
                    "x": round(player.x, 2),
                    "z": round(player.z, 2),
                    "why": verdict.reason,
                },
            )
            return
        player.x, player.z, player.yaw, player.s = msg.x, msg.z, msg.yaw, min(msg.s, 10.0)
        player.t_move = now
        player.dirty = True
        player.room.place(player)

    def _set_position(self, player: Player, x: float, z: float, yaw: float, why: str) -> None:
        player.x, player.z, player.yaw, player.s = x, z, yaw, 0.0
        player.t_move = time.monotonic()
        player.dirty = True
        player.room.place(player)
        self.send(
            player,
            {"t": "teleport", "x": round(x, 2), "z": round(z, 2), "yaw": round(yaw, 3), "why": why},
        )

    async def _chat(self, player: Player, msg: Chat) -> None:
        now = time.monotonic()
        if player.chat_muted_until and player.chat_muted_until > utcnow():
            return self._error(
                player,
                "CHAT_MUTED",
                "A moderator has muted your chat until "
                f"{player.chat_muted_until:%Y-%m-%d %H:%M} UTC.",
            )
        while player.chat_times and player.chat_times[0] < now - CHAT_WINDOW_S:
            player.chat_times.popleft()
        if len(player.chat_times) >= CHAT_MAX:
            return self._error(player, "RATE_LIMITED", "You are sending messages too quickly.")
        if msg.ch == "world" and now - player.last_world_chat < WORLD_CHAT_GAP_S:
            return self._error(player, "RATE_LIMITED", "Wait a moment before chatting to everyone.")
        body, flagged = chatfilter.prepare(msg.text)
        if not body:
            return
        player.chat_times.append(now)
        if msg.ch == "world":
            player.last_world_chat = now
        out = {
            "t": "chat",
            "id": player.sid,
            "u": player.username,
            "n": player.display_name,
            "ch": msg.ch,
            "text": body,
            "ts": int(time.time() * 1000),
        }
        for other in player.room.players.values():
            if other is not player:
                if other.user_id in player.blocked or player.user_id in other.blocked:
                    continue
                if player.user_id in other.muted:
                    continue
                if (
                    msg.ch == "nearby"
                    and math.hypot(other.x - player.x, other.z - player.z) > NEARBY_CHAT_RADIUS_M
                ):
                    continue
                if msg.ch == "nearby" and not player.visible:
                    continue  # hidden players cannot speak into the street
            self.send(other, out)
        async with SessionLocal() as session:
            session.add(
                ChatMessage(
                    room_id=player.room.id,
                    sender_id=player.user_id,
                    channel=msg.ch,
                    body=body,
                    flagged=flagged,
                )
            )
            await session.commit()

    def _emote(self, player: Player, msg: Emote) -> None:
        now = time.monotonic()
        if now - player.last_emote < EMOTE_GAP_S:
            return
        player.last_emote = now
        out = {"t": "emote", "id": player.sid, "e": msg.e}
        self.send(player, out)
        for other in player.room.players.values():
            if player.sid in other.known:
                self.send(other, out)

    def _travel(self, player: Player, msg: Travel) -> None:
        now = time.monotonic()
        spawn = player.room.spawns.get(msg.spawn)
        if spawn is None:
            return self._error(player, "UNKNOWN_PLACE", "That place does not exist.")
        if now - player.last_travel < TRAVEL_GAP_S:
            return self._error(player, "RATE_LIMITED", "Wait a moment before travelling again.")
        player.last_travel = now
        x, z = self._arrival_spot(player.room, spawn[0], spawn[1], player.sid, exclude=player)
        self._set_position(player, x, z, spawn[2], why="travel")

    def _invite(self, player: Player, msg: Invite) -> None:
        target = next((p for p in self.by_user.values() if p.username == msg.to.lower()), None)
        if target is None or target.user_id not in player.friends or not target.visible:
            return self._error(player, "NOT_AVAILABLE", "That friend is not online.")
        if player.user_id in target.blocked or target.user_id in player.blocked:
            return self._error(player, "NOT_AVAILABLE", "That friend is not online.")
        target.invites[player.user_id] = time.monotonic() + INVITE_TTL_S
        self.send(target, {"t": "invite", "u": player.username, "n": player.display_name})
        self.send(
            player,
            {"t": "notify", "kind": "invite_sent", "u": target.username, "n": target.display_name},
        )

    def _join(self, player: Player, msg: Join) -> None:
        inviter = next((p for p in self.by_user.values() if p.username == msg.from_.lower()), None)
        expiry = player.invites.pop(inviter.user_id, 0) if inviter else 0
        if inviter is None or expiry < time.monotonic():
            return self._error(player, "INVITE_EXPIRED", "That invitation is no longer valid.")
        if inviter.room is not player.room:
            return self._error(player, "OTHER_ROOM", "Your friend is in another room.")
        others = [(p.x, p.z) for p in player.room.players.values() if p is not player]
        x, z = player.room.validator.free_spot_near(inviter.x, inviter.z, others=others)
        yaw = math.atan2(inviter.x - x, inviter.z - z)  # face the friend
        self._set_position(player, x, z, yaw, why="join")

    # ── relationships & moderation (called by REST endpoints) ───────────────────────────
    def update_relations(self, user_id: uuid.UUID, relations: dict[str, set[uuid.UUID]]) -> None:
        player = self.by_user.get(user_id)
        if player:
            player.blocked = relations.get("blocked", set())
            player.muted = relations.get("muted", set())
            player.friends = relations.get("friends", set())

    def update_visibility(self, user_id: uuid.UUID, visible: bool) -> None:
        player = self.by_user.get(user_id)
        if player:
            player.visible = visible

    def set_chat_mute(self, user_id: uuid.UUID, until: datetime | None) -> None:
        player = self.by_user.get(user_id)
        if player:
            player.chat_muted_until = until

    async def persist_and_revalidate(self) -> None:
        """Save virtual positions; disconnect players whose login session ended."""
        players = list(self.by_user.values())
        if not players:
            return
        async with SessionLocal() as session:
            now = utcnow()
            for p in players:
                if p.session_row_id:
                    await session.execute(
                        update(PlayerSession)
                        .where(PlayerSession.id == p.session_row_id)
                        .values(last_x=p.x, last_z=p.z, last_seen_at=now)
                    )
            ended = set(
                (
                    await session.execute(
                        text("""
                SELECT u.id FROM users u
                LEFT JOIN sessions s ON s.id = ANY(:sids) AND s.user_id = u.id
                WHERE u.id = ANY(:uids) AND (NOT u.is_active OR s.id IS NULL
                      OR s.revoked_at IS NOT NULL OR s.expires_at <= now())
            """),
                        {
                            "uids": [p.user_id for p in players],
                            "sids": [p.auth_session_id for p in players if p.auth_session_id],
                        },
                    )
                ).scalars()
            )
            await session.commit()
        for p in players:
            if p.user_id in ended:
                await self.kick(p, "session_ended")


hub = Hub()
