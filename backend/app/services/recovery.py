"""Expiring random reset tokens, stored as hashes, revoke all sessions on use."""

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, bad_request
from app.core.security import hash_password
from app.models import AuthSession, PasswordReset, User
from app.services import accounts, audit, notifier
from app.utils.time import utcnow

MESSAGE = "If an active account matches, we sent password reset instructions."


async def request_reset(session: AsyncSession, identifier: str) -> dict:
    result: dict = {"message": MESSAGE}
    user = await accounts.find_by_identifier(session, identifier)
    if user is None or not user.is_active or not user.contact_verified:
        return result
    channel = "email" if user.email_verified_at else "phone"
    destination = user.email if channel == "email" else user.phone
    if not notifier.capabilities()[channel]:
        return result
    await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
    latest = await session.scalar(
        select(PasswordReset)
        .where(PasswordReset.user_id == user.id)
        .order_by(PasswordReset.created_at.desc())
        .limit(1)
    )
    if latest and latest.created_at > utcnow() - timedelta(minutes=1):
        return result
    now = utcnow()
    await session.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.consumed_at.is_(None))
        .values(consumed_at=now)
    )
    token = secrets.token_urlsafe(32)
    session.add(
        PasswordReset(
            user_id=user.id,
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=now + timedelta(minutes=15),
        )
    )
    try:
        await notifier.deliver_message(
            channel,
            destination,
            f"Your password reset token is {token}. "
            "Paste it on the password reset page within 15 minutes. "
            "If you did not request this, ignore this message.",
        )
    except AppError:
        await session.rollback()
        return result
    await session.commit()
    if settings.app_env != "production" and settings.expose_dev_verification_codes:
        result["dev_token"] = token
    return result


async def reset(session: AsyncSession, token: str, password: str) -> None:
    hashed = hashlib.sha256(token.encode()).hexdigest()
    user_id = await session.scalar(
        select(PasswordReset.user_id).where(PasswordReset.token_hash == hashed)
    )
    if user_id is None:
        raise bad_request(
            "INVALID_RESET", "This reset token is invalid or expired. Request another."
        )
    user = await session.scalar(select(User).where(User.id == user_id).with_for_update(of=User))
    row = await session.scalar(
        select(PasswordReset)
        .where(PasswordReset.token_hash == hashed)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not user or not user.is_active or not row or row.consumed_at or row.expires_at <= utcnow():
        raise bad_request(
            "INVALID_RESET", "This reset token is invalid or expired. Request another."
        )
    user.password_hash = hash_password(password)
    now = utcnow()
    await session.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user_id, PasswordReset.consumed_at.is_(None))
        .values(consumed_at=now)
    )
    await session.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    audit.record(
        session, "account.password_reset", actor=user.id, target_type="user", target_id=user.id
    )
    await session.commit()
    from app.multiplayer.hub import hub

    player = hub.by_user.get(user.id)
    if player:
        await hub.kick(player, "Password changed. Sign in again.")
