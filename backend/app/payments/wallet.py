"""Demo credits only. Every transfer has a balanced, immutable journal and locked balances."""

import uuid

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict
from app.models import LedgerEntry, LedgerTransaction, User, WalletAccount

STARTER_CREDITS = 10_000
SYSTEM = "system:demo"
ESCROW = "system:escrow"


def user_key(user_id: uuid.UUID) -> str:
    return f"user:{user_id}"


async def accounts(session: AsyncSession, keys: list[str]) -> None:
    for key in sorted(set(keys)):
        await session.execute(
            insert(WalletAccount)
            .values(
                key=key,
                user_id=uuid.UUID(key[5:]) if key.startswith("user:") else None,
                balance_minor=0,
            )
            .on_conflict_do_nothing()
        )


async def transfer(
    session: AsyncSession,
    source: str,
    target: str,
    amount: int,
    reference: str,
    kind: str,
) -> LedgerTransaction:
    if amount <= 0 or source == target:
        raise ValueError("A transfer needs a positive amount and distinct accounts")
    # Transactions may contain several transfers (starter, payment, or split payouts).
    # Serialize the demo journal in PostgreSQL to preserve one lock order across all of them.
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtext('ppw:demo-ledger'))"))
    await accounts(session, [source, target])
    locked = {
        row.key: row
        for row in (
            await session.scalars(
                select(WalletAccount)
                .where(WalletAccount.key.in_([source, target]))
                .order_by(WalletAccount.key)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).all()
    }
    existing = await session.scalar(
        select(LedgerTransaction).where(LedgerTransaction.reference == reference)
    )
    if existing:
        entries = (
            await session.execute(
                select(LedgerEntry.account_key, LedgerEntry.amount_minor).where(
                    LedgerEntry.transaction_id == existing.id
                )
            )
        ).all()
        if existing.kind != kind or dict(entries) != {source: -amount, target: amount}:
            raise conflict(
                "IDEMPOTENCY_KEY_REUSED", "This transfer key belongs to another request."
            )
        return existing
    if source != SYSTEM and locked[source].balance_minor < amount:
        raise conflict("INSUFFICIENT_FUNDS", "Not enough demo credits. Add credits in your wallet.")
    transaction = LedgerTransaction(reference=reference, kind=kind, amount_minor=amount)
    session.add(transaction)
    await session.flush()
    session.add_all(
        [
            LedgerEntry(transaction_id=transaction.id, account_key=source, amount_minor=-amount),
            LedgerEntry(transaction_id=transaction.id, account_key=target, amount_minor=amount),
        ]
    )
    locked[source].balance_minor -= amount
    locked[target].balance_minor += amount
    await session.flush()
    return transaction


async def ensure_wallet(session: AsyncSession, user_id: uuid.UUID) -> str:
    key = user_key(user_id)
    await transfer(session, SYSTEM, key, STARTER_CREDITS, f"starter:{user_id}", "starter_credit")
    return key


async def summary(session: AsyncSession, user: User) -> dict:
    key = await ensure_wallet(session, user.id)
    balance = await session.scalar(
        select(WalletAccount.balance_minor).where(WalletAccount.key == key)
    )
    rows = (
        await session.execute(
            select(LedgerTransaction, LedgerEntry.amount_minor)
            .join(LedgerEntry, LedgerEntry.transaction_id == LedgerTransaction.id)
            .where(LedgerEntry.account_key == key)
            .order_by(LedgerTransaction.created_at.desc(), LedgerTransaction.id.desc())
            .limit(50)
        )
    ).all()
    await session.commit()
    return {
        "balance_minor": balance,
        "currency": "USD",
        "is_demo": True,
        "transactions": [
            {
                "id": transaction.id,
                "kind": transaction.kind,
                "amount_minor": amount,
                "created_at": transaction.created_at,
            }
            for transaction, amount in rows
        ],
    }


async def pay(session: AsyncSession, user: User, intent_id: uuid.UUID, amount: int) -> None:
    key = await ensure_wallet(session, user.id)
    await transfer(session, key, ESCROW, amount, f"payment:{intent_id}", "payment")


async def refund(session: AsyncSession, order) -> None:
    # Existing demo payments from before this migration have no wallet debit to return.
    paid = await session.scalar(
        select(LedgerTransaction.id).where(
            LedgerTransaction.reference == f"payment:{order.payment_intent_id}"
        )
    )
    if paid and order.buyer_id:
        await transfer(
            session,
            ESCROW,
            user_key(order.buyer_id),
            order.total_minor,
            f"refund:{order.id}",
            "refund",
        )


async def settle(session: AsyncSession, order) -> None:
    paid = await session.scalar(
        select(LedgerTransaction.id).where(
            LedgerTransaction.reference == f"payment:{order.payment_intent_id}"
        )
    )
    if not paid:
        return
    if order.subtotal_minor:
        await transfer(
            session,
            ESCROW,
            user_key(order.merchant.owner_id),
            order.subtotal_minor,
            f"merchant:{order.id}",
            "merchant_payout",
        )
    if order.delivery_fee_minor:
        from app.models import DeliveryJob

        driver = await session.scalar(
            select(DeliveryJob.driver_id).where(DeliveryJob.order_id == order.id)
        )
        if driver:
            await transfer(
                session,
                ESCROW,
                user_key(driver),
                order.delivery_fee_minor,
                f"driver:{order.id}",
                "driver_payout",
            )
