"""Simulated delivery, balanced demo credits, and single-use account recovery."""

import uuid
from datetime import datetime

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
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKey


class DriverProfile(TimestampMixin, Base):
    __tablename__ = "driver_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    online: Mapped[bool] = mapped_column(Boolean, default=False)
    vehicle_kind: Mapped[str] = mapped_column(String(16), default="motorbike")
    __table_args__ = (CheckConstraint("vehicle_kind IN ('bicycle','motorbike')", name="vehicle"),)


class DeliveryJob(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "delivery_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('waiting','assigned','picked_up','in_transit','delivered','cancelled')",
            name="status_valid",
        ),
        Index(
            "ix_delivery_jobs_active_driver",
            "driver_id",
            unique=True,
            postgresql_where="status IN ('assigned','picked_up','in_transit')",
        ),
    )

    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), unique=True)
    driver_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), default="waiting")
    pickup_x: Mapped[float] = mapped_column(Float)
    pickup_z: Mapped[float] = mapped_column(Float)
    dropoff_x: Mapped[float] = mapped_column(Float)
    dropoff_z: Mapped[float] = mapped_column(Float)
    dropoff_label: Mapped[str] = mapped_column(String(100))
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class WalletAccount(TimestampMixin, Base):
    __tablename__ = "wallet_accounts"
    __table_args__ = (
        CheckConstraint("balance_minor >= 0 OR key = 'system:demo'", name="nonnegative"),
    )

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), unique=True)
    balance_minor: Mapped[int] = mapped_column(BigInteger, default=0)


class LedgerTransaction(UUIDPrimaryKey, CreatedAtMixin, Base):
    __tablename__ = "ledger_transactions"

    reference: Mapped[str] = mapped_column(String(160), unique=True)
    kind: Mapped[str] = mapped_column(String(24))
    amount_minor: Mapped[int] = mapped_column(Integer)
    __table_args__ = (CheckConstraint("amount_minor > 0", name="positive"),)


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("ledger_transactions.id"), index=True
    )
    account_key: Mapped[str] = mapped_column(ForeignKey("wallet_accounts.key"), index=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (CheckConstraint("amount_minor <> 0", name="nonzero"),)


class PasswordReset(UUIDPrimaryKey, CreatedAtMixin, Base):
    __tablename__ = "password_resets"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
