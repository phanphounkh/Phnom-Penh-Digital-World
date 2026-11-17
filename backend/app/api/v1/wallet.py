"""Authenticated, clearly labelled simulated credits; never real money."""

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.core.errors import AppError, bad_request
from app.core.rate_limit import rate_limit
from app.marketplace.checkout import IDEMPOTENCY_KEY
from app.payments import wallet

router = APIRouter(prefix="/wallet", tags=["demo wallet"])


class CreditIn(BaseModel):
    amount_minor: int = Field(ge=100, le=100_000)


@router.get("")
async def balance(user: CurrentUser, session: SessionDep):
    return await wallet.summary(session, user)


@router.post("/credits", dependencies=[Depends(rate_limit("demo-credits", 10, 3600))])
async def credit(
    data: CreditIn,
    user: CurrentUser,
    session: SessionDep,
    idempotency_key: str = Header(max_length=64),
):
    if not settings.demo_payments_enabled:
        raise AppError(403, "PAYMENTS_DISABLED", "Demo credits are disabled.")
    if not IDEMPOTENCY_KEY.fullmatch(idempotency_key):
        raise bad_request("IDEMPOTENCY_KEY_REQUIRED", "Use an 8–64 character transfer key.")
    key = await wallet.ensure_wallet(session, user.id)
    await wallet.transfer(
        session,
        wallet.SYSTEM,
        key,
        data.amount_minor,
        f"credit:{user.id}:{idempotency_key}",
        "demo_credit",
    )
    await session.commit()
    return await wallet.summary(session, user)
