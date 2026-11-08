from fastapi import APIRouter

from app.api.v1 import admin, auth, geo, me, players, realtime, social, world

api_router = APIRouter(prefix="/api/v1")


@api_router.get("/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


for module in (auth, me, geo, world, realtime, players, social, admin):
    api_router.include_router(module.router)
