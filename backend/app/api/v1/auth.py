import uuid

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select

from app.api.deps import ClientIP, CurrentSession, CurrentUser, SessionDep, get_auth
from app.core.config import settings
from app.core.errors import AppError, not_found
from app.core.rate_limit import limiter, rate_limit
from app.core.security import new_csrf_token
from app.models import AuthSession, User
from app.schemas.auth import (
    AuthSessionOut,
    LoginRequest,
    MeOut,
    RegisterRequest,
    SessionOut,
    VerificationConfirmRequest,
    VerificationOut,
    VerificationSendRequest,
)
from app.schemas.common import Message
from app.services import accounts, audit
from app.services.onboarding import me_out
from app.utils.time import utcnow

router = APIRouter(prefix="/auth", tags=["auth"])


async def _start_session(
    request: Request, response: Response, session: SessionDep, user: User, ip: str
) -> tuple[str, AuthSession]:
    token, record = await accounts.open_session(
        session, user, ip, request.headers.get("user-agent")
    )
    csrf = new_csrf_token()
    max_age = settings.session_ttl_minutes * 60
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    # Readable by the web app so it can echo it in the X-CSRF-Token header (double submit).
    response.set_cookie(
        settings.csrf_cookie_name,
        csrf,
        max_age=max_age,
        httponly=False,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return csrf, record


def _clear_cookies(response: Response) -> None:
    for name in (settings.session_cookie_name, settings.csrf_cookie_name):
        response.delete_cookie(name, path="/", secure=settings.cookie_secure, samesite="lax")


@router.post(
    "/register",
    response_model=SessionOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit("register", 5, 300))],
    summary="Create an account, start a session and send a verification code",
)
async def register(
    data: RegisterRequest,
    request: Request,
    response: Response,
    session: SessionDep,
    ip: ClientIP,
) -> SessionOut:
    user = await accounts.register(session, data, ip)
    verification = await accounts.start_verification(session, user, None, enforce_cooldown=False)
    csrf, record = await _start_session(request, response, session, user, ip)
    await session.commit()
    return SessionOut(
        user=await me_out(session, user),
        csrf_token=csrf,
        expires_at=record.expires_at,
        verification=verification,
    )


@router.post(
    "/login",
    response_model=SessionOut,
    dependencies=[Depends(rate_limit("login", 10, 60))],
    summary="Sign in with a username, email or phone number and password",
)
async def login(
    data: LoginRequest, request: Request, response: Response, session: SessionDep, ip: ClientIP
) -> SessionOut:
    # Per-account limit too, so one account cannot be brute-forced from many addresses.
    retry = limiter.hit(f"login-id:{data.identifier.strip().lower()}", 10, 900)
    if retry is not None:
        raise AppError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many sign-in attempts. Please wait and try again.",
            headers={"Retry-After": str(retry)},
        )
    user = await accounts.authenticate(session, data.identifier, data.password)
    csrf, record = await _start_session(request, response, session, user, ip)
    audit.record(
        session, "account.login", actor=user.id, target_type="session", target_id=record.id, ip=ip
    )
    await session.commit()
    return SessionOut(
        user=await me_out(session, user), csrf_token=csrf, expires_at=record.expires_at
    )


@router.post("/logout", response_model=Message, summary="Sign out and revoke this session")
async def logout(response: Response, session: SessionDep, request: Request) -> Message:
    # Not a hard dependency: signing out must succeed even with an invalid/expired session.
    auth = await get_auth(request, session)
    if auth is not None:
        user, record = auth
        await accounts.revoke_session(session, record.id, user.id)
        await session.commit()
    _clear_cookies(response)
    return Message(message="Signed out")


@router.get("/me", response_model=MeOut, summary="The signed-in user and onboarding state")
async def me(user: CurrentUser, session: SessionDep) -> MeOut:
    return await me_out(session, user)


@router.post(
    "/verification/send",
    response_model=VerificationOut,
    dependencies=[Depends(rate_limit("verify-send", 6, 3600))],
    summary="Send a new one-time code to the account's email or phone",
)
async def send_code(
    data: VerificationSendRequest, user: CurrentUser, session: SessionDep
) -> VerificationOut:
    result = await accounts.start_verification(
        session, user, data.channel.value if data.channel else None
    )
    await session.commit()
    return result


@router.post(
    "/verification/confirm",
    response_model=MeOut,
    dependencies=[Depends(rate_limit("verify-confirm", 20, 600))],
    summary="Confirm the one-time code",
)
async def confirm_code(
    data: VerificationConfirmRequest, user: CurrentUser, session: SessionDep
) -> MeOut:
    await accounts.confirm_verification(session, user, data.code)
    await session.commit()
    return await me_out(session, user)


@router.get("/sessions", response_model=list[AuthSessionOut], summary="Your active sessions")
async def list_sessions(
    user: CurrentUser, current: CurrentSession, session: SessionDep
) -> list[AuthSessionOut]:
    rows = await session.scalars(
        select(AuthSession)
        .where(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > utcnow(),
        )
        .order_by(AuthSession.created_at.desc())
    )
    return [
        AuthSessionOut(
            id=r.id,
            created_at=r.created_at,
            last_seen_at=r.last_seen_at,
            expires_at=r.expires_at,
            user_agent=r.user_agent,
            current=r.id == current.id,
        )
        for r in rows
    ]


@router.delete("/sessions/{session_id}", response_model=Message, summary="Revoke a session")
async def revoke(session_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    if not await accounts.revoke_session(session, session_id, user.id):
        raise not_found("Session")
    await session.commit()
    return Message(message="Session revoked")
