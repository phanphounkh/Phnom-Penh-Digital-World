"""The world WebSocket: /api/v1/world/ws (same origin; cookie-authenticated)."""

import logging

from fastapi import APIRouter, WebSocket

from app.api.deps import resolve_session_token
from app.core.config import settings
from app.core.database import SessionLocal
from app.models import AvatarCustomization
from app.multiplayer.hub import hub
from app.schemas.me import AvatarIn
from app.services import geo, social, world

router = APIRouter(tags=["realtime"])
logger = logging.getLogger("ppw.ws")

# Close codes (4000 + HTTP-like status) let the client explain the failure.
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_UNAUTHORIZED = 4401
CLOSE_ONBOARDING = 4409


def client_ip(ws: WebSocket) -> str | None:
    if settings.trust_proxy_headers and (fwd := ws.headers.get("x-forwarded-for")):
        return fwd.split(",")[0].strip()
    return ws.client.host if ws.client else None


@router.websocket("/world/ws")
async def world_socket(ws: WebSocket) -> None:
    # Cookies ride along on cross-site WebSocket handshakes, so the Origin check is what stops
    # another website from opening a world connection as the signed-in user.
    origin = (ws.headers.get("origin") or "").rstrip("/")
    if origin not in settings.allowed_origins:
        await ws.close(code=CLOSE_FORBIDDEN_ORIGIN)
        return
    async with SessionLocal() as session:
        auth = await resolve_session_token(session, ws.cookies.get(settings.session_cookie_name))
        if auth is None:
            await ws.close(code=CLOSE_UNAUTHORIZED)
            return
        user, record = auth
        avatar = await session.get(AvatarCustomization, user.id)
        spawn = (
            await geo.spawn_point(session, user.profile.spawn_point_id) if user.profile else None
        )
        if user.onboarding_completed_at is None or avatar is None or spawn is None:
            await ws.close(code=CLOSE_ONBOARDING)
            return
        start = await world.start_position(session, user, spawn)
        relations = await social.relations(session, user.id)
        profile = user.profile
        join = {
            "user_id": user.id,
            "username": user.username,
            "display_name": profile.display_name,
            "avatar": AvatarIn.model_validate(avatar, from_attributes=True).model_dump(),
            "visible": bool(profile.world_visible),
            "region_slug": spawn.region,
            "x": start.x,
            "z": start.z,
            "yaw": start.yaw,
            "auth_session_id": record.id,
            "relations": relations,
            "chat_muted_until": profile.chat_muted_until,
        }
    await ws.accept()
    player = await hub.join(ws, **join, ip=client_ip(ws), user_agent=ws.headers.get("user-agent"))
    reason = "left"
    try:
        while not player.closing:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            text = message.get("text")
            if text is None:
                await hub.handle(player, "")  # binary frames are not part of the protocol
                continue
            await hub.handle(player, text)
    except Exception:  # network errors end the session like a disconnect
        logger.exception("World socket error for %s", player.username)
        reason = "error"
    finally:
        if not player.closing:
            await hub.leave(player, reason)
