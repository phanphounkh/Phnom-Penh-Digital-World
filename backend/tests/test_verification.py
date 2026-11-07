from datetime import timedelta

import httpx
from sqlalchemy import update

from app.core.database import SessionLocal
from app.models import ContactVerification
from tests.conftest import register


def wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


async def test_correct_code_verifies_contact(client: httpx.AsyncClient):
    code = (await register(client))["verification"]["dev_code"]
    r = await client.post("/auth/verification/confirm", json={"code": code})
    assert r.status_code == 200
    assert r.json()["email_verified"] is True
    assert r.json()["onboarding"]["next_step"] == "avatar"


async def test_code_cannot_be_reused(client: httpx.AsyncClient):
    code = (await register(client))["verification"]["dev_code"]
    assert (await client.post("/auth/verification/confirm", json={"code": code})).status_code == 200
    again = await client.post("/auth/verification/confirm", json={"code": code})
    assert again.status_code == 400 and again.json()["error"]["code"] == "CODE_EXPIRED"


async def test_wrong_codes_are_limited(client: httpx.AsyncClient):
    code = (await register(client))["verification"]["dev_code"]
    for remaining in (4, 3, 2, 1, 0):
        r = await client.post("/auth/verification/confirm", json={"code": wrong(code)})
        assert r.status_code == 400
        assert r.json()["error"]["details"]["attempts_remaining"] == remaining
    # Even the right code is refused after too many failures; a new code is required.
    locked = await client.post("/auth/verification/confirm", json={"code": code})
    assert locked.status_code == 429 and locked.json()["error"]["code"] == "TOO_MANY_ATTEMPTS"


async def test_expired_code_is_refused(client: httpx.AsyncClient):
    code = (await register(client))["verification"]["dev_code"]
    async with SessionLocal() as session:
        await session.execute(
            update(ContactVerification).values(
                expires_at=ContactVerification.created_at - timedelta(seconds=1)
            )
        )
        await session.commit()
    r = await client.post("/auth/verification/confirm", json={"code": code})
    assert r.status_code == 400 and r.json()["error"]["code"] == "CODE_EXPIRED"


async def test_resend_has_cooldown_and_replaces_old_code(client: httpx.AsyncClient):
    old = (await register(client))["verification"]["dev_code"]
    too_soon = await client.post("/auth/verification/send", json={})
    assert too_soon.status_code == 429 and "Retry-After" in too_soon.headers
    async with SessionLocal() as session:  # pretend the cooldown passed
        await session.execute(
            update(ContactVerification).values(
                created_at=ContactVerification.created_at - timedelta(minutes=5)
            )
        )
        await session.commit()
    new = (await client.post("/auth/verification/send", json={})).json()["dev_code"]
    if new != old:
        stale = await client.post("/auth/verification/confirm", json={"code": old})
        assert stale.status_code == 400
    assert (await client.post("/auth/verification/confirm", json={"code": new})).status_code == 200


async def test_verification_requires_sign_in(client: httpx.AsyncClient):
    r = await client.post("/auth/verification/confirm", json={"code": "123456"})
    assert r.status_code == 401
