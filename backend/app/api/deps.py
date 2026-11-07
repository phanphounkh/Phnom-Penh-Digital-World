"""Shared FastAPI dependencies: DB session, current user/session and role guards."""

import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_session
from app.core.errors import AppError
from app.core.rate_limit import client_ip
from app.core.security import decode_session_token
from app.models import AuthSession, RoleName, User
from app.utils.time import utcnow

SessionDep = Annotated[AsyncSession, Depends(get_session)]
TOUCH_INTERVAL = timedelta(minutes=5)


async def get_auth(request: Request, session: SessionDep) -> tuple[User, AuthSession] | None:
    token = request.cookies.get(settings.session_cookie_name)
    if not token:
        return None
    payload = decode_session_token(token)
    if payload is None:
        return None
    try:
        user_id, session_id = uuid.UUID(payload["sub"]), uuid.UUID(payload["sid"])
    except (KeyError, ValueError):
        return None
    record = await session.get(AuthSession, session_id)
    now = utcnow()
    if (
        record is None
        or record.user_id != user_id
        or record.revoked_at is not None
        or record.expires_at <= now
    ):
        return None
    # Always re-read the user: role changes and deactivation take effect immediately.
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        return None
    if now - record.last_seen_at > TOUCH_INTERVAL:
        record.last_seen_at = now
        await session.commit()
    return user, record


AuthDep = Annotated[tuple[User, AuthSession] | None, Depends(get_auth)]


def _unauthorized() -> AppError:
    return AppError(status.HTTP_401_UNAUTHORIZED, "UNAUTHORIZED", "Please sign in to continue.")


async def optional_user(auth: AuthDep) -> User | None:
    return auth[0] if auth else None


async def require_user(auth: AuthDep) -> User:
    if auth is None:
        raise _unauthorized()
    return auth[0]


async def require_session(auth: AuthDep) -> AuthSession:
    if auth is None:
        raise _unauthorized()
    return auth[1]


def require_role(role: RoleName):
    async def dependency(user: Annotated[User, Depends(require_user)]) -> User:
        if not user.has_role(role):
            raise AppError(
                status.HTTP_403_FORBIDDEN, "FORBIDDEN", "You do not have permission to do that."
            )
        return user

    return dependency


def ip_of(request: Request) -> str:
    return client_ip(request)


OptionalUser = Annotated[User | None, Depends(optional_user)]
CurrentUser = Annotated[User, Depends(require_user)]
CurrentSession = Annotated[AuthSession, Depends(require_session)]
AdminUser = Annotated[User, Depends(require_role(RoleName.ADMIN))]
ClientIP = Annotated[str, Depends(ip_of)]
