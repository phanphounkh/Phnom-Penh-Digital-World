"""Set a new random password for an account (development / recovery).

    uv run python scripts/set_password.py admin

Prints the new password once. Existing sign-ins stay valid; revoke them from the account's
sessions page if needed. Refuses to run with APP_ENV=production.
"""

import asyncio
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.core.security import hash_password
from app.models import User
from app.services import audit


async def main(username: str) -> None:
    if settings.app_env == "production":
        raise SystemExit("Refusing to reset passwords with APP_ENV=production")
    password = secrets.token_urlsafe(12)
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.username == username.lower()))
        if user is None:
            raise SystemExit(f"No account '{username}'")
        user.password_hash = hash_password(password)
        audit.record(session, "account.password_reset_cli", target_type="user", target_id=user.id)
        await session.commit()
    await engine.dispose()
    print(f"New password for '{username}': {password}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: set_password.py <username>")
    asyncio.run(main(sys.argv[1]))
