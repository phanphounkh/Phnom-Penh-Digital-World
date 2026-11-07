"""Create the bootstrap administrator (idempotent).

    uv run python scripts/seed.py

Reads SEED_ADMIN_USERNAME / SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. If the password is empty
a random one is generated and printed ONCE. The admin is pre-verified and has completed
onboarding prerequisites except the avatar/location (set them in the app).
"""

import asyncio
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv
from sqlalchemy import select

from app.core.config import REPO_ROOT, settings
from app.core.database import SessionLocal, engine
from app.core.security import hash_password
from app.models import RoleName, RoleStatus, User, UserProfile, UserRole
from app.utils.time import utcnow

load_dotenv(REPO_ROOT / ".env")


async def main() -> None:
    username = os.environ.get("SEED_ADMIN_USERNAME", "admin").lower()
    email = os.environ.get("SEED_ADMIN_EMAIL", "admin@ppw.local").lower()
    password = os.environ.get("SEED_ADMIN_PASSWORD", "")
    generated = not password
    if generated:
        password = secrets.token_urlsafe(14)
    elif len(password) < 10:
        raise SystemExit("SEED_ADMIN_PASSWORD must be at least 10 characters")

    async with SessionLocal() as session:
        existing = await session.scalar(select(User).where(User.username == username))
        if existing:
            print(f"Admin '{username}' already exists; nothing to do.")
            return
        now = utcnow()
        user = User(
            username=username,
            email=email,
            password_hash=hash_password(password),
            email_verified_at=now,
            terms_version=settings.terms_version,
            terms_accepted_at=now,
            privacy_accepted_at=now,
        )
        user.profile = UserProfile(display_name="Administrator", preferred_language="en")
        user.roles = [
            UserRole(role=r, status=RoleStatus.ACTIVE, requested_at=now, decided_at=now)
            for r in (RoleName.VISITOR, RoleName.ADMIN)
        ]
        session.add(user)
        await session.commit()
    await engine.dispose()
    print(f"Created admin '{username}' <{email}>.")
    if generated:
        print(f"Generated password (shown once): {password}")


if __name__ == "__main__":
    asyncio.run(main())
