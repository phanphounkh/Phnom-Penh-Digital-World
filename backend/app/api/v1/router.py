from fastapi import APIRouter

from app.api.v1 import (
    admin,
    admin_market,
    auth,
    geo,
    market,
    me,
    merchant,
    players,
    realtime,
    shopping,
    social,
    transport,
    world,
)

api_router = APIRouter(prefix="/api/v1")


@api_router.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


for module in (
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
