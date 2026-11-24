"""Account-level keepsakes, separate from currency and marketplace fulfilment."""

import uuid

from sqlalchemy import Boolean, ForeignKey, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base, TimestampMixin


class PlayerPassport(Base, TimestampMixin):
    __tablename__ = "player_passports"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    stamps: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb")
    )
    delivered: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
