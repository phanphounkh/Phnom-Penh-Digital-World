"""Registration, login, server-side sessions and contact verification."""

import uuid
from datetime import timedelta

from fastapi import status
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, conflict
from app.core.security import (
    create_session_token,
    hash_password,
    hash_verification_code,
    new_verification_code,
    tokens_match,
    verify_password,
)
from app.models import (
    AuthSession,
    ContactVerification,
    RoleName,
    RoleStatus,
    User,
    UserProfile,
    UserRole,
)
from app.schemas.auth import RegisterRequest, VerificationOut, clean_phone
from app.services import audit
from app.services.notifier import deliver_verification_code, mask_destination
from app.utils.time import utcnow


async def find_by_identifier(session: AsyncSession, identifier: str) -> User | None:
    identifier = identifier.strip()
    if "@" in identifier:
        clause = func.lower(User.email) == identifier.lower()
    elif identifier.lstrip("+").replace(" ", "").replace("-", "").isdigit():
        try:
            phone = clean_phone(identifier)
        except ValueError:
            return None
        clause = User.phone == phone
    else:
        clause = User.username == identifier.lower()
    return await session.scalar(select(User).where(clause))


async def register(session: AsyncSession, data: RegisterRequest, ip: str | None) -> User:
    taken = await session.scalar(
        select(User.username).where(
            or_(
                User.username == data.username,
                User.email == data.email if data.email else False,
                User.phone == data.phone if data.phone else False,
            )
        )
    )
    if taken is not None:
        raise conflict("ACCOUNT_EXISTS", "That username, email or phone number is already in use.")
    now = utcnow()
    user = User(
        id=uuid.uuid4(),
        username=data.username,
        email=data.email,
        phone=data.phone,
        password_hash=hash_password(data.password),
        terms_version=settings.terms_version,
        terms_accepted_at=now,
        privacy_accepted_at=now,
    )
    user.profile = UserProfile(
        display_name=data.display_name, preferred_language=data.preferred_language.value
    )
    user.roles = [
        UserRole(role=RoleName.VISITOR, status=RoleStatus.ACTIVE, requested_at=now, decided_at=now)
    ]
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        # Only a unique violation means a concurrent registration took the name/contact.
        if getattr(exc.orig, "sqlstate", None) != "23505":
            raise
        raise conflict(
            "ACCOUNT_EXISTS", "That username, email or phone number is already in use."
        ) from exc
    # After the flush: audit_logs has no ORM relationship, so the user row must exist first.
    audit.record(
        session,
        "account.registered",
        actor=user.id,
        target_type="user",
        target_id=user.id,
        ip=ip,
        channels=[c for c in ("email", "phone") if getattr(data, c)],
    )
    return user


async def authenticate(session: AsyncSession, identifier: str, password: str) -> User:
    user = await find_by_identifier(session, identifier)
    valid = verify_password(password, user.password_hash if user else None)
    if user is None or not valid or not user.is_active:
        raise AppError(
            status.HTTP_401_UNAUTHORIZED,
            "INVALID_CREDENTIALS",
            "Incorrect username, email, phone or password.",
        )
    return user


async def open_session(
    session: AsyncSession, user: User, ip: str | None, user_agent: str | None
) -> tuple[str, AuthSession]:
    now = utcnow()
    record = AuthSession(
        id=uuid.uuid4(),
        user_id=user.id,
        expires_at=now + timedelta(minutes=settings.session_ttl_minutes),
        last_seen_at=now,
        ip_address=ip,
        user_agent=(user_agent or "")[:255] or None,
    )
    session.add(record)
    user.last_login_at = now
    token = create_session_token(user.id, record.id, record.expires_at)
    return token, record


async def revoke_session(session: AsyncSession, session_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    result = await session.execute(
        update(AuthSession)
        .where(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    return result.rowcount > 0


# ── contact verification ─────────────────────────────────────────────────────────────────
def _default_channel(user: User) -> str:
    return "email" if user.email else "phone"


async def start_verification(
    session: AsyncSession, user: User, channel: str | None, *, enforce_cooldown: bool = True
) -> VerificationOut:
    channel = channel or _default_channel(user)
    destination = user.email if channel == "email" else user.phone
    if not destination:
        raise AppError(
            status.HTTP_400_BAD_REQUEST, "NO_CONTACT", f"Your account has no {channel} to verify."
        )
    now = utcnow()
    latest = await session.scalar(
        select(ContactVerification)
        .where(ContactVerification.user_id == user.id)
        .order_by(ContactVerification.created_at.desc())
        .limit(1)
    )
    if enforce_cooldown and latest is not None:
        wait = settings.verification_resend_seconds - (now - latest.created_at).total_seconds()
        if wait > 0:
            raise AppError(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "RESEND_TOO_SOON",
                "Please wait before requesting another code.",
                headers={"Retry-After": str(int(wait) + 1)},
            )
    # Any earlier unused code stops working once a new one is issued.
    await session.execute(
        update(ContactVerification)
        .where(ContactVerification.user_id == user.id, ContactVerification.consumed_at.is_(None))
        .values(consumed_at=now)
    )
    code = new_verification_code()
    verification = ContactVerification(
        id=uuid.uuid4(),
        user_id=user.id,
        channel=channel,
        destination=destination,
        expires_at=now + timedelta(minutes=settings.verification_code_ttl_minutes),
    )
    verification.code_hash = hash_verification_code(verification.id, code)
    session.add(verification)
    deliver_verification_code(channel, destination, code)
    return VerificationOut(
        channel=channel,
        destination=mask_destination(channel, destination),
        expires_at=verification.expires_at,
        resend_after_seconds=settings.verification_resend_seconds,
        dev_code=code if settings.expose_dev_verification_codes else None,
    )


async def confirm_verification(session: AsyncSession, user: User, code: str) -> str:
    now = utcnow()
    verification = await session.scalar(
        select(ContactVerification)
        .where(ContactVerification.user_id == user.id, ContactVerification.consumed_at.is_(None))
        .order_by(ContactVerification.created_at.desc())
        .limit(1)
        .with_for_update()
    )
    if verification is None or verification.expires_at <= now:
        raise AppError(
            status.HTTP_400_BAD_REQUEST, "CODE_EXPIRED", "This code has expired. Request a new one."
        )
    if verification.attempts >= settings.verification_max_attempts:
        raise AppError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "TOO_MANY_ATTEMPTS",
            "Too many incorrect attempts. Request a new code.",
        )
    if not tokens_match(hash_verification_code(verification.id, code), verification.code_hash):
        verification.attempts += 1
        await session.commit()
        remaining = settings.verification_max_attempts - verification.attempts
        raise AppError(
            status.HTTP_400_BAD_REQUEST,
            "CODE_INVALID",
            "That code is not correct.",
            details={"attempts_remaining": remaining},
        )
    verification.consumed_at = now
    if verification.channel == "email" and verification.destination == user.email:
        user.email_verified_at = now
    elif verification.channel == "phone" and verification.destination == user.phone:
        user.phone_verified_at = now
    else:  # contact details changed since the code was sent
        raise AppError(
            status.HTTP_400_BAD_REQUEST, "CODE_EXPIRED", "This code has expired. Request a new one."
        )
    audit.record(
        session,
        "account.contact_verified",
        actor=user.id,
        target_type="user",
        target_id=user.id,
        channel=verification.channel,
    )
    return verification.channel
