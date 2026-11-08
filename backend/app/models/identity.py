"""Accounts, roles, profiles, sessions, avatars, verification and private addresses."""

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKey

ROLE_VALUES = "'visitor','buyer','seller','driver','admin'"
ROLE_STATUS_VALUES = "'active','pending','rejected','revoked'"


class User(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("email IS NOT NULL OR phone IS NOT NULL", name="has_contact"),
        CheckConstraint("username ~ '^[a-z0-9_.]{3,24}$'", name="username_format"),
    )

    username: Mapped[str] = mapped_column(String(24), unique=True)
    email: Mapped[str | None] = mapped_column(String(255), unique=True)
    phone: Mapped[str | None] = mapped_column(String(20), unique=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    terms_version: Mapped[str] = mapped_column(String(32))
    terms_accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    privacy_accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    roles: Mapped[list["UserRole"]] = relationship(
        back_populates="user",
        lazy="selectin",
        cascade="all, delete-orphan",
        foreign_keys="UserRole.user_id",
    )
    profile: Mapped["UserProfile | None"] = relationship(
        back_populates="user", lazy="selectin", cascade="all, delete-orphan", uselist=False
    )

    @property
    def contact_verified(self) -> bool:
        return self.email_verified_at is not None or self.phone_verified_at is not None

    def has_role(self, role: str) -> bool:
        return any(r.role == role and r.status == "active" for r in self.roles)

    @property
    def active_roles(self) -> list[str]:
        return sorted(r.role for r in self.roles if r.status == "active")


class UserRole(UUIDPrimaryKey, Base):
    """One row per (user, role). Seller and driver roles start `pending` until approved."""

    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role", name="uq_user_roles_user_role"),
        CheckConstraint(f"role IN ({ROLE_VALUES})", name="role_valid"),
        CheckConstraint(f"status IN ({ROLE_STATUS_VALUES})", name="status_valid"),
        Index("ix_user_roles_status_role", "status", "role"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(String(500))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    decision_reason: Mapped[str | None] = mapped_column(String(500))

    user: Mapped[User] = relationship(back_populates="roles", foreign_keys=[user_id])


class UserProfile(TimestampMixin, Base):
    __tablename__ = "user_profiles"
    __table_args__ = (CheckConstraint("preferred_language IN ('en','km')", name="language"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    display_name: Mapped[str] = mapped_column(String(48))
    preferred_language: Mapped[str] = mapped_column(String(2), default="en")
    # Explicit opt-in: NULL until the user chooses, false hides the avatar from other players.
    world_visible: Mapped[bool | None] = mapped_column(Boolean)
    spawn_point_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("player_spawn_points.id", ondelete="SET NULL")
    )
    # Set when the user confirms their role choice during onboarding (even "visitor only").
    roles_chosen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Moderation: no public chat until this time.
    chat_muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="profile")


class AuthSession(UUIDPrimaryKey, CreatedAtMixin, Base):
    """Server-side session record. The cookie token names it, so logout truly revokes it."""

    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_active", "user_id", "revoked_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class ContactVerification(UUIDPrimaryKey, CreatedAtMixin, Base):
    __tablename__ = "contact_verifications"
    __table_args__ = (
        CheckConstraint("channel IN ('email','phone')", name="channel_valid"),
        Index("ix_contact_verifications_user_created", "user_id", "created_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    channel: Mapped[str] = mapped_column(String(8))
    destination: Mapped[str] = mapped_column(String(255))
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


AVATAR_CHECKS = (
    CheckConstraint("body IN ('a','b')", name="body"),
    CheckConstraint("hair_style IN ('short','long','bun','buzz')", name="hair_style"),
    CheckConstraint("top_style IN ('hoodie','tee')", name="top_style"),
    CheckConstraint("bottom_style IN ('trousers','shorts')", name="bottom_style"),
    *(
        CheckConstraint(f"{c} ~ '^#[0-9a-f]{{6}}$'", name=f"{c}_hex")
        for c in (
            "skin_tone",
            "hair_color",
            "top_color",
            "bottom_color",
            "shoe_color",
            "accent_color",
        )
    ),
    CheckConstraint("cardinality(accessories) <= 3", name="accessory_count"),
)


class AvatarCustomization(TimestampMixin, Base):
    __tablename__ = "avatar_customizations"
    __table_args__ = AVATAR_CHECKS

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    avatar_name: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(32), default="avatar", server_default="avatar")
    body: Mapped[str] = mapped_column(String(1))
    skin_tone: Mapped[str] = mapped_column(String(7))
    hair_style: Mapped[str] = mapped_column(String(8))
    hair_color: Mapped[str] = mapped_column(String(7))
    top_style: Mapped[str] = mapped_column(String(8))
    top_color: Mapped[str] = mapped_column(String(7))
    bottom_style: Mapped[str] = mapped_column(String(10))
    bottom_color: Mapped[str] = mapped_column(String(7))
    shoe_color: Mapped[str] = mapped_column(String(7))
    accent_color: Mapped[str] = mapped_column(String(7))
    accessories: Mapped[list[str]] = mapped_column(
        ARRAY(String(12)), default=list, server_default="{}"
    )


class UserAddress(UUIDPrimaryKey, TimestampMixin, Base):
    """A PRIVATE delivery address. Never exposed publicly or tied to the avatar position."""

    __tablename__ = "user_addresses"
    __table_args__ = (
        Index("ix_user_addresses_user", "user_id"),
        Index("ix_user_addresses_location", "location", postgresql_using="gist"),
        Index(
            "uq_user_addresses_one_default",
            "user_id",
            unique=True,
            postgresql_where="is_default",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(40))
    location: Mapped[object] = mapped_column(Geography("POINT", srid=4326, spatial_index=False))
    address_line: Mapped[str] = mapped_column(String(200))
    details: Mapped[str | None] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
