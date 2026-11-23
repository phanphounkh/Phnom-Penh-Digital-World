from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.deps import SessionDep
from app.api.v1 import (
    admin,
    admin_market,
    auth,
    delivery,
    geo,
    market,
    me,
    merchant,
    players,
    realtime,
    shopping,
    social,
    transport,
    wallet,
    world,
)

api_router = APIRouter(prefix="/api/v1")


@api_router.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


# The newest migration (migrations/versions): ready once the database is at it.
SCHEMA_REVISION = "0006"


@api_router.get("/health/ready", tags=["health"])
async def ready(session: SessionDep):
    try:
        version = await session.scalar(text("SELECT version_num FROM alembic_version"))
        if version != SCHEMA_REVISION:
            return JSONResponse({"status": "not_ready"}, status_code=503)
    except Exception:
        return JSONResponse({"status": "not_ready"}, status_code=503)
    return {"status": "ready"}


for module in (
    delivery,
    wallet,
    auth,
    me,
    geo,
    world,
    realtime,
    players,
    social,
    market,
    merchant,
    shopping,
    transport,
    admin,
    admin_market,
):
    api_router.include_router(module.router)
api_router.include_router(market.media_router)
