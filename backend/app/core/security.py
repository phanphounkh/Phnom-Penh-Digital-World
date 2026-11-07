"""Password hashing, session tokens, CSRF tokens and one-time verification codes."""

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime
from typing import Any

import jwt
from pwdlib import PasswordHash

from app.core.config import settings

# Argon2id with pwdlib's recommended parameters.
password_hasher = PasswordHash.recommended()

# Used to equalise timing when a login identifier does not exist.
_DUMMY_HASH = password_hasher.hash("ppw-timing-equaliser")


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        password_hasher.verify(password, _DUMMY_HASH)
        return False
    try:
        return password_hasher.verify(password, password_hash)
    except Exception:
        return False


def create_session_token(user_id: uuid.UUID, session_id: uuid.UUID, expires_at: datetime) -> str:
    """A signed token that names a server-side session row, so sessions can be revoked."""
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "sid": str(session_id),
        "exp": expires_at,
        "iat": datetime.now(expires_at.tzinfo),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_session_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["sub", "sid", "exp"]},
        )
    except jwt.PyJWTError:
        return None


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def tokens_match(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode(), b.encode())


def new_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_verification_code(verification_id: uuid.UUID, code: str) -> str:
    # Keyed by the server secret and bound to one verification row: a leaked table is useless
    # without the secret, and a code cannot be replayed against another verification.
    message = f"{verification_id}:{code}".encode()
    return hmac.new(settings.jwt_secret.encode(), message, hashlib.sha256).hexdigest()
