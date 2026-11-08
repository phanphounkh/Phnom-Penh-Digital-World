"""Friends, blocks, mutes, direct messages and player reports."""

import uuid
from datetime import timedelta
from typing import Any

from fastapi import status
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, not_found
from app.models import (
    ChatMessage,
    Friendship,
    PlayerReport,
    User,
    UserBlock,
    UserMute,
)
from app.multiplayer import chatfilter
from app.multiplayer.hub import hub
from app.services import audit
from app.utils.time import utcnow


def _err(code: str, message: str, http: int = status.HTTP_409_CONFLICT) -> AppError:
    return AppError(http, code, message)


async def player_by_username(session: AsyncSession, username: str) -> User:
    user = await session.scalar(select(User).where(User.username == username.strip().lower()))
    if user is None or not user.is_active or user.onboarding_completed_at is None:
        raise not_found("Player")
    return user


async def relations(session: AsyncSession, user_id: uuid.UUID) -> dict[str, set[uuid.UUID]]:
    """blocked (either direction), muted (by me), friends (accepted) — for the world hub."""
    blocked = set(
        (
            await session.execute(
                select(UserBlock.blocked_id)
                .where(UserBlock.blocker_id == user_id)
                .union(select(UserBlock.blocker_id).where(UserBlock.blocked_id == user_id))
            )
        ).scalars()
    )
    muted = set(
        (await session.scalars(select(UserMute.muted_id).where(UserMute.muter_id == user_id))).all()
    )
    rows = await session.execute(
        select(Friendship.requester_id, Friendship.addressee_id).where(
            Friendship.status == "accepted",
            or_(Friendship.requester_id == user_id, Friendship.addressee_id == user_id),
        )
    )
    friends = {a if b == user_id else b for a, b in rows}
    return {"blocked": blocked, "muted": muted, "friends": friends}


async def refresh_hub(session: AsyncSession, *user_ids: uuid.UUID) -> None:
    for user_id in user_ids:
        hub.update_relations(user_id, await relations(session, user_id))


async def is_blocked_between(session: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> bool:
    return bool(
        await session.scalar(
            select(func.count())
            .select_from(UserBlock)
            .where(
                or_(
                    and_(UserBlock.blocker_id == a, UserBlock.blocked_id == b),
                    and_(UserBlock.blocker_id == b, UserBlock.blocked_id == a),
                )
            )
        )
    )


def _pair(a: uuid.UUID, b: uuid.UUID):
    return or_(
        and_(Friendship.requester_id == a, Friendship.addressee_id == b),
        and_(Friendship.requester_id == b, Friendship.addressee_id == a),
    )


# ── friends ─────────────────────────────────────────────────────────────────────────────
async def list_friends(session: AsyncSession, me: User) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(Friendship, User)
        .join(
            User,
            or_(
                and_(Friendship.requester_id == me.id, User.id == Friendship.addressee_id),
                and_(Friendship.addressee_id == me.id, User.id == Friendship.requester_id),
            ),
        )
        .order_by(Friendship.created_at.desc())
    )
    out = []
    for friendship, other in rows:
        accepted = friendship.status == "accepted"
        out.append(
            {
                "username": other.username,
                "display_name": other.profile.display_name if other.profile else other.username,
                "status": friendship.status
                if accepted
                else ("outgoing" if friendship.requester_id == me.id else "incoming"),
                # Presence is shared with accepted friends only, and only while visible.
                "online": accepted and hub.is_online(other.id),
                "since": friendship.responded_at or friendship.created_at,
            }
        )
    return out


async def request_friend(session: AsyncSession, me: User, other: User) -> str:
    if other.id == me.id:
        raise _err("SELF", "You cannot add yourself.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    if await is_blocked_between(session, me.id, other.id):
        raise not_found("Player")  # a block is not revealed
    existing = await session.scalar(select(Friendship).where(_pair(me.id, other.id)))
    if existing is not None:
        if existing.status == "accepted":
            raise _err("ALREADY_FRIENDS", "You are already friends.")
        if existing.requester_id == me.id:
            raise _err("ALREADY_REQUESTED", "Friend request already sent.")
        # They asked first: asking back accepts.
        return await respond(session, me, other, accept=True)
    pending = await session.scalar(
        select(func.count())
        .select_from(Friendship)
        .where(Friendship.requester_id == me.id, Friendship.status == "pending")
    )
    if pending >= 50:
        raise _err(
            "TOO_MANY_REQUESTS",
            "You have too many pending friend requests.",
            status.HTTP_429_TOO_MANY_REQUESTS,
        )
    session.add(Friendship(requester_id=me.id, addressee_id=other.id, status="pending"))
    await session.commit()
    hub.notify_user(
        other.id,
        {
            "t": "notify",
            "kind": "friend_request",
            "u": me.username,
            "n": me.profile.display_name if me.profile else me.username,
        },
    )
    return "pending"


async def respond(session: AsyncSession, me: User, other: User, accept: bool) -> str:
    friendship = await session.scalar(
        select(Friendship).where(
            Friendship.requester_id == other.id,
            Friendship.addressee_id == me.id,
            Friendship.status == "pending",
        )
    )
    if friendship is None:
        raise not_found("Friend request")
    if accept:
        friendship.status = "accepted"
        friendship.responded_at = utcnow()
    else:
        await session.delete(friendship)
    await session.commit()
    if accept:
        await refresh_hub(session, me.id, other.id)
        hub.notify_user(
            other.id,
            {
                "t": "notify",
                "kind": "friend_accepted",
                "u": me.username,
                "n": me.profile.display_name if me.profile else me.username,
            },
        )
    return "accepted" if accept else "declined"


async def remove_friend(session: AsyncSession, me: User, other: User) -> None:
    result = await session.execute(delete(Friendship).where(_pair(me.id, other.id)))
    if not result.rowcount:
        raise not_found("Friend")
    await session.commit()
    await refresh_hub(session, me.id, other.id)


# ── blocks & mutes ──────────────────────────────────────────────────────────────────────
async def block(session: AsyncSession, me: User, other: User) -> None:
    if other.id == me.id:
        raise _err("SELF", "You cannot block yourself.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    await session.execute(
        insert(UserBlock).values(blocker_id=me.id, blocked_id=other.id).on_conflict_do_nothing()
    )
    await session.execute(delete(Friendship).where(_pair(me.id, other.id)))
    audit.record(session, "social.blocked", actor=me.id, target_type="user", target_id=other.id)
    await session.commit()
    await refresh_hub(session, me.id, other.id)


async def unblock(session: AsyncSession, me: User, other: User) -> None:
    await session.execute(
        delete(UserBlock).where(UserBlock.blocker_id == me.id, UserBlock.blocked_id == other.id)
    )
    await session.commit()
    await refresh_hub(session, me.id, other.id)


async def mute(session: AsyncSession, me: User, other: User) -> None:
    if other.id == me.id:
        raise _err("SELF", "You cannot mute yourself.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    await session.execute(
        insert(UserMute).values(muter_id=me.id, muted_id=other.id).on_conflict_do_nothing()
    )
    await session.commit()
    await refresh_hub(session, me.id)


async def unmute(session: AsyncSession, me: User, other: User) -> None:
    await session.execute(
        delete(UserMute).where(UserMute.muter_id == me.id, UserMute.muted_id == other.id)
    )
    await session.commit()
    await refresh_hub(session, me.id)


async def list_blocks_and_mutes(session: AsyncSession, me: User) -> dict[str, list[str]]:
    blocked = await session.scalars(
        select(User.username)
        .join(UserBlock, UserBlock.blocked_id == User.id)
        .where(UserBlock.blocker_id == me.id)
        .order_by(User.username)
    )
    muted = await session.scalars(
        select(User.username)
        .join(UserMute, UserMute.muted_id == User.id)
        .where(UserMute.muter_id == me.id)
        .order_by(User.username)
    )
    return {"blocked": list(blocked), "muted": list(muted)}


# ── direct messages ─────────────────────────────────────────────────────────────────────
def _chat_muted(user: User) -> bool:
    until = user.profile.chat_muted_until if user.profile else None
    return bool(until and until > utcnow())


async def send_direct(session: AsyncSession, me: User, other: User, text: str) -> ChatMessage:
    if other.id == me.id:
        raise _err("SELF", "You cannot message yourself.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    if _chat_muted(me):
        raise _err("CHAT_MUTED", "A moderator has muted your chat.", status.HTTP_403_FORBIDDEN)
    if await is_blocked_between(session, me.id, other.id):
        raise not_found("Player")
    recent = await session.scalar(
        select(func.count())
        .select_from(ChatMessage)
        .where(
            ChatMessage.sender_id == me.id,
            ChatMessage.channel == "direct",
            ChatMessage.created_at > utcnow() - timedelta(minutes=1),
        )
    )
    if recent >= 20:
        raise _err(
            "RATE_LIMITED",
            "You are sending messages too quickly.",
            status.HTTP_429_TOO_MANY_REQUESTS,
        )
    body, flagged = chatfilter.prepare(text)
    if not body:
        raise _err("EMPTY", "Message is empty.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    message = ChatMessage(
        sender_id=me.id, recipient_id=other.id, channel="direct", body=body, flagged=flagged
    )
    session.add(message)
    await session.commit()
    muted_by_other = bool(
        await session.scalar(
            select(func.count())
            .select_from(UserMute)
            .where(UserMute.muter_id == other.id, UserMute.muted_id == me.id)
        )
    )
    if not muted_by_other:
        hub.notify_user(
            other.id,
            {
                "t": "notify",
                "kind": "dm",
                "u": me.username,
                "n": me.profile.display_name if me.profile else me.username,
                "text": body,
                "ts": int(message.created_at.timestamp() * 1000),
            },
        )
    return message


async def conversations(session: AsyncSession, me: User) -> list[dict[str, Any]]:
    peer = func.coalesce(func.nullif(ChatMessage.recipient_id, me.id), ChatMessage.sender_id).label(
        "peer"
    )
    latest = (
        select(
            peer,
            func.max(ChatMessage.id).label("last_id"),
            func.count()
            .filter(and_(ChatMessage.recipient_id == me.id, ChatMessage.read_at.is_(None)))
            .label("unread"),
        )
        .where(
            ChatMessage.channel == "direct",
            or_(ChatMessage.sender_id == me.id, ChatMessage.recipient_id == me.id),
            ChatMessage.hidden_at.is_(None),
        )
        .group_by(peer)
        .subquery()
    )
    rows = await session.execute(
        select(User, ChatMessage, latest.c.unread)
        .join(latest, latest.c.peer == User.id)
        .join(ChatMessage, ChatMessage.id == latest.c.last_id)
        .order_by(ChatMessage.id.desc())
    )
    return [
        {
            "username": u.username,
            "display_name": u.profile.display_name if u.profile else u.username,
            "last": m.body,
            "last_at": m.created_at,
            "from_me": m.sender_id == me.id,
            "unread": unread,
        }
        for u, m, unread in rows
    ]


async def thread(
    session: AsyncSession, me: User, other: User, limit: int = 50
) -> list[dict[str, Any]]:
    rows = (
        await session.scalars(
            select(ChatMessage)
            .where(
                ChatMessage.channel == "direct",
                ChatMessage.hidden_at.is_(None),
                or_(
                    and_(ChatMessage.sender_id == me.id, ChatMessage.recipient_id == other.id),
                    and_(ChatMessage.sender_id == other.id, ChatMessage.recipient_id == me.id),
                ),
            )
            .order_by(ChatMessage.id.desc())
            .limit(limit)
        )
    ).all()
    await session.execute(
        update(ChatMessage)
        .where(
            ChatMessage.sender_id == other.id,
            ChatMessage.recipient_id == me.id,
            ChatMessage.read_at.is_(None),
        )
        .values(read_at=utcnow())
    )
    await session.commit()
    return [
        {"from_me": m.sender_id == me.id, "text": m.body, "at": m.created_at}
        for m in reversed(rows)
    ]


# ── reports ─────────────────────────────────────────────────────────────────────────────
async def report(
    session: AsyncSession, me: User, other: User, reason: str, details: str | None, ip: str | None
) -> PlayerReport:
    if other.id == me.id:
        raise _err("SELF", "You cannot report yourself.", status.HTTP_422_UNPROCESSABLE_CONTENT)
    recent_reports = await session.scalar(
        select(func.count())
        .select_from(PlayerReport)
        .where(
            PlayerReport.reporter_id == me.id,
            PlayerReport.created_at > utcnow() - timedelta(hours=1),
        )
    )
    if recent_reports >= 10:
        raise _err(
            "RATE_LIMITED",
            "You have sent many reports recently.",
            status.HTTP_429_TOO_MANY_REQUESTS,
        )
    since = utcnow() - timedelta(hours=24)
    public = (
        await session.scalars(
            select(ChatMessage)
            .where(
                ChatMessage.sender_id == other.id,
                ChatMessage.channel != "direct",
                ChatMessage.created_at > since,
            )
            .order_by(ChatMessage.id.desc())
            .limit(20)
        )
    ).all()
    direct = (
        await session.scalars(
            select(ChatMessage)
            .where(
                ChatMessage.sender_id == other.id,
                ChatMessage.recipient_id == me.id,
                ChatMessage.created_at > since,
            )
            .order_by(ChatMessage.id.desc())
            .limit(20)
        )
    ).all()
    context = {
        "messages": [
            {
                "id": m.id,
                "channel": m.channel,
                "text": m.body,
                "at": m.created_at.isoformat(),
                "flagged": m.flagged,
            }
            for m in sorted([*public, *direct], key=lambda m: m.id)
        ]
    }
    row = PlayerReport(
        reporter_id=me.id,
        reported_id=other.id,
        reason=reason,
        details=(details or "").strip()[:1000] or None,
        context=context,
    )
    session.add(row)
    await session.flush()
    audit.record(
        session,
        "social.reported",
        actor=me.id,
        target_type="user",
        target_id=other.id,
        ip=ip,
        reason=reason,
        report_id=str(row.id),
    )
    await session.commit()
    return row
