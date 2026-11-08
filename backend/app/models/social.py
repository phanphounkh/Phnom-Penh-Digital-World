"""Multiplayer and social data: rooms, world sessions, friends, blocks, mutes, chat, reports."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKey


class WorldRoom(UUIDPrimaryKey, TimestampMixin, Base):
    """One running instance (shard) of a playable region."""

    __tablename__ = "world_rooms"

    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    capacity: Mapped[int] = mapped_column(Integer, default=150, server_default="150")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class PlayerSession(UUIDPrimaryKey, Base):
    """One connection of a player to a world room (presence history)."""

    __tablename__ = "player_sessions"
    __table_args__ = (
        Index("ix_player_sessions_user_connected", "user_id", "connected_at"),
        Index("ix_player_sessions_open", "room_id", postgresql_where="disconnected_at IS NULL"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    room_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("world_rooms.id", ondelete="CASCADE"))
    auth_session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL")
    )
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    disconnect_reason: Mapped[str | None] = mapped_column(String(32))
    # Virtual avatar position (world metres) — never a real-world location.
    last_x: Mapped[float | None] = mapped_column(Float)
    last_z: Mapped[float | None] = mapped_column(Float)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class Friendship(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "friendships"
    __table_args__ = (
        CheckConstraint("requester_id <> addressee_id", name="not_self"),
        CheckConstraint("status IN ('pending','accepted')", name="status_valid"),
        # One relationship per pair, whichever side asked.
        Index(
            "uq_friendships_pair",
            text("least(requester_id, addressee_id)"),
            text("greatest(requester_id, addressee_id)"),
            unique=True,
        ),
        Index("ix_friendships_addressee_status", "addressee_id", "status"),
    )

    requester_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    addressee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(10), default="pending")
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserBlock(CreatedAtMixin, Base):
    """A block hides both players from each other and stops friend requests and messages."""

    __tablename__ = "user_blocks"
    __table_args__ = (CheckConstraint("blocker_id <> blocked_id", name="not_self"),)

    blocker_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    blocked_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class UserMute(CreatedAtMixin, Base):
    """A mute hides someone's chat from the muter only."""

    __tablename__ = "user_mutes"
    __table_args__ = (CheckConstraint("muter_id <> muted_id", name="not_self"),)

    muter_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    muted_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )


class ChatMessage(CreatedAtMixin, Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        CheckConstraint("channel IN ('nearby','world','direct')", name="channel_valid"),
        CheckConstraint(
            "(channel = 'direct') = (recipient_id IS NOT NULL)", name="direct_has_recipient"
        ),
        Index("ix_chat_messages_sender_created", "sender_id", "created_at"),
        Index("ix_chat_messages_recipient_read", "recipient_id", "read_at"),
        Index("ix_chat_messages_room_created", "room_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("world_rooms.id", ondelete="SET NULL")
    )
    sender_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    recipient_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    channel: Mapped[str] = mapped_column(String(8))
    body: Mapped[str] = mapped_column(Text)
    flagged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


REPORT_REASONS = ("harassment", "hate", "spam", "cheating", "inappropriate_name", "other")


class PlayerReport(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "player_reports"
    __table_args__ = (
        CheckConstraint("status IN ('open','resolved','dismissed')", name="status_valid"),
        CheckConstraint(
            "reason IN ('harassment','hate','spam','cheating','inappropriate_name','other')",
            name="reason_valid",
        ),
        Index("ix_player_reports_status_created", "status", "created_at"),
    )

    reporter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reported_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reason: Mapped[str] = mapped_column(String(24))
    details: Mapped[str | None] = mapped_column(String(1000))
    # Snapshot of the reported player's recent public chat, so moderators see what was said.
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    status: Mapped[str] = mapped_column(String(10), default="open", server_default="open")
    action: Mapped[str | None] = mapped_column(String(24))
    resolution_note: Mapped[str | None] = mapped_column(Text)
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
