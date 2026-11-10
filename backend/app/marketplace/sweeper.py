"""Background housekeeping for the marketplace: expire claims past their term (or review
window) and unpaid checkouts past their payment window. Each run is idempotent; the same
functions also run lazily when the affected rows are read."""

import asyncio
import contextlib
import logging

from app.core.database import SessionLocal
from app.marketplace import checkout, claims

logger = logging.getLogger("ppw.sweeper")
INTERVAL_SECONDS = 60


async def sweep_once() -> dict[str, int]:
    async with SessionLocal() as session:
        expired_claims = await claims.expire_due(session)
    async with SessionLocal() as session:
        expired_payments = await checkout.expire_due_payments(session)
    return {"claims": expired_claims, "payments": expired_payments}


async def run_forever() -> None:
    while True:
        await asyncio.sleep(INTERVAL_SECONDS)
        try:
            result = await sweep_once()
            if any(result.values()):
                logger.info("Marketplace sweep: %s", result)
        except Exception:
            logger.exception("Marketplace sweep failed")


@contextlib.asynccontextmanager
async def running():
    task = asyncio.create_task(run_forever(), name="market-sweeper")
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
