"""Test fixtures.

Tests run against a real PostgreSQL + PostGIS database (`ppw_test`) because spatial queries,
partial unique indexes and row locking matter here. The schema is built with the real
Alembic migrations and the real OSM snapshot is imported once per session (exercising the
importer). Identity tables are truncated between tests; geography is kept.
"""

import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from dotenv import dotenv_values

# ── Configure the environment BEFORE importing the application ──
_env = {**dotenv_values(Path(__file__).resolve().parents[2] / ".env"), **os.environ}
_test_url = _env.get("TEST_DATABASE_URL") or (
    (_env.get("DATABASE_URL") or "").rstrip("/") + "_test"
)
if not _test_url or not _test_url.endswith("_test"):
    raise RuntimeError("TEST_DATABASE_URL must point to a database whose name ends in _test")
os.environ.update(
    {
        "APP_ENV": "test",
        "DATABASE_URL": _test_url,
        "COOKIE_SECURE": "false",
        "TRUST_PROXY_HEADERS": "false",
        "EXPOSE_DEV_VERIFICATION_CODES": "true",
        "WORLD_TICK_HZ": "20",
        "WORLD_RESUME_MINUTES": "15",
        "JWT_SECRET": "test-secret-" + "x" * 40,
        "MEDIA_ROOT": __import__("tempfile").mkdtemp(prefix="ppw-test-media-"),
        "DEMO_PAYMENTS_ENABLED": "true",
    }
)

import httpx
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.rate_limit import limiter
from app.core.security import hash_password
from app.geography.importer import import_all
from app.main import app
from app.models import RoleName, RoleStatus, User, UserProfile, UserRole
from app.multiplayer.hub import hub
from app.utils.time import utcnow

BACKEND_DIR = Path(__file__).resolve().parents[1]
PASSWORD = "correct-horse-battery"
# Points used across tests (WGS84).
CENTRAL_MARKET = (11.56955, 104.92115)
TOUL_KORK = (11.5800, 104.8990)  # inside Phnom Penh, outside the playable neighbourhood
SIEM_REAP = (13.3633, 103.8564)  # outside the service area


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    """Recreate the test schema from the Alembic migrations and import the OSM snapshot."""
    import asyncio

    async def _reset_schema() -> None:
        engine = create_async_engine(_test_url)
        async with engine.begin() as conn:
            await conn.execute(text("DROP SCHEMA public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
        await engine.dispose()

    asyncio.run(_reset_schema())
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = _test_url
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session", autouse=True)
async def imported_geography(migrated_database: None) -> dict[str, Any]:
    async with SessionLocal() as session:
        return await import_all(session, settings.osm_data_dir)


IDENTITY_TABLES = (
    "vehicles, refunds, order_events, order_items, orders, payment_intents, cart_items, carts, "
    "inventory, products, shops, property_disputes, property_transfers, property_claims, "
    "merchant_verifications, merchants, "
    "player_reports, chat_messages, user_mutes, user_blocks, friendships, player_sessions, "
    "world_rooms, audit_logs, user_addresses, avatar_customizations, contact_verifications, "
    "sessions, user_roles, user_profiles, users"
)


@pytest.fixture(autouse=True)
async def clean_db(imported_geography: dict[str, Any]) -> AsyncIterator[None]:
    await hub.reset()
    async with SessionLocal() as session:
        await session.execute(text(f"TRUNCATE {IDENTITY_TABLES} RESTART IDENTITY CASCADE"))
        await session.commit()
    limiter.reset()
    yield


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver.local/api/v1"
    )


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with make_client() as c:
        yield c


def adopt_csrf(c: httpx.AsyncClient) -> None:
    # Browsers echo the readable CSRF cookie in a header (double-submit pattern).
    c.headers["X-CSRF-Token"] = c.cookies["ppw_csrf"]


def registration(username: str = "sokha", **overrides: Any) -> dict[str, Any]:
    return {
        "username": username,
        "email": f"{username}@example.com",
        "password": PASSWORD,
        "display_name": username.title(),
        "preferred_language": "en",
        "accept_terms": True,
        "accept_privacy": True,
        **overrides,
    }


async def register(c: httpx.AsyncClient, username: str = "sokha", **overrides: Any) -> dict:
    response = await c.post("/auth/register", json=registration(username, **overrides))
    assert response.status_code == 201, response.text
    adopt_csrf(c)
    return response.json()


async def register_verified(c: httpx.AsyncClient, username: str = "sokha", **kw: Any) -> dict:
    body = await register(c, username, **kw)
    code = body["verification"]["dev_code"]
    response = await c.post("/auth/verification/confirm", json={"code": code})
    assert response.status_code == 200, response.text
    return response.json()


AVATAR = {
    "avatar_name": "Sokha",
    "body": "a",
    "skin_tone": "#c8946b",
    "hair_style": "short",
    "hair_color": "#2b2220",
    "top_style": "tee",
    "top_color": "#2f7d6d",
    "bottom_style": "trousers",
    "bottom_color": "#343b4a",
    "shoe_color": "#eee5d5",
    "accent_color": "#d9a441",
    "accessories": ["cap"],
}


async def first_spawn_id(c: httpx.AsyncClient) -> str:
    return (await c.get("/geo/spawn-points")).json()[0]["id"]


async def onboard(
    c: httpx.AsyncClient,
    username: str = "sokha",
    roles: list[str] | None = None,
    visible: bool = True,
) -> dict:
    """Register and finish onboarding through the public API, like the web client."""
    await register_verified(c, username)
    assert (await c.put("/me/avatar", json=AVATAR)).status_code == 200
    roles = ["buyer"] if roles is None else roles
    assert (await c.post("/me/roles", json={"roles": roles})).status_code == 200
    if "buyer" in roles:
        lat, lon = CENTRAL_MARKET
        address = {"label": "Home", "lat": lat, "lon": lon, "address_line": "Street 130"}
        assert (await c.post("/me/addresses", json=address)).status_code == 201
    spawn = {"spawn_point_id": await first_spawn_id(c), "world_visible": visible}
    assert (await c.put("/me/spawn", json=spawn)).status_code == 200
    response = await c.post("/me/onboarding/complete")
    assert response.status_code == 200, response.text
    return (await c.get("/auth/me")).json()


async def create_admin(username: str = "chief") -> None:
    async with SessionLocal() as session:
        now = utcnow()
        user = User(
            username=username,
            email=f"{username}@ppw.local",
            email_verified_at=now,
            password_hash=hash_password(PASSWORD),
            terms_version="test",
            terms_accepted_at=now,
            privacy_accepted_at=now,
        )
        user.profile = UserProfile(display_name="Chief Admin", preferred_language="en")
        user.roles = [
            UserRole(role=r, status=RoleStatus.ACTIVE, requested_at=now, decided_at=now)
            for r in (RoleName.VISITOR, RoleName.ADMIN)
        ]
        session.add(user)
        await session.commit()


@pytest.fixture
async def admin_client() -> AsyncIterator[httpx.AsyncClient]:
    await create_admin()
    async with make_client() as c:
        response = await c.post("/auth/login", json={"identifier": "chief", "password": PASSWORD})
        assert response.status_code == 200, response.text
        adopt_csrf(c)
        yield c


# ── WebSocket helpers ───────────────────────────────────────────────────────────────────
import asyncio
import contextlib
import json

from httpx_ws import aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport

ORIGIN = "http://localhost:5173"


@contextlib.asynccontextmanager
async def world_socket(c: httpx.AsyncClient, origin: str | None = ORIGIN):
    """Open /api/v1/world/ws with the cookies of an HTTP test client."""
    async with httpx.AsyncClient(
        transport=ASGIWebSocketTransport(app), base_url="http://testserver.local"
    ) as wsc:
        wsc.cookies = c.cookies
        headers = {"origin": origin} if origin else {}
        async with aconnect_ws("/api/v1/world/ws", wsc, headers=headers) as ws:
            ws.inbox = []  # messages received while waiting for something else
            yield ws


async def expect(ws, kind: str, timeout: float = 3.0, where=None) -> dict:
    """Next message of type `kind` (optionally matching `where`), keeping others in ws.inbox."""
    for i, msg in enumerate(ws.inbox):
        if msg["t"] == kind and (where is None or where(msg)):
            return ws.inbox.pop(i)
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise AssertionError(f"no {kind!r} message; got {[m['t'] for m in ws.inbox]}")
        try:
            msg = json.loads(await ws.receive_text(timeout=remaining))
        except TimeoutError as exc:
            raise AssertionError(f"no {kind!r} message; got {[m['t'] for m in ws.inbox]}") from exc
        if msg["t"] == kind and (where is None or where(msg)):
            return msg
        ws.inbox.append(msg)


async def never(ws, kind: str, wait: float = 0.6, where=None) -> None:
    """Assert no message of `kind` arrives within `wait` seconds."""
    with contextlib.suppress(AssertionError):
        msg = await expect(ws, kind, wait, where)
        raise RuntimeError(f"unexpected {kind!r}: {msg}")


async def send(ws, **message) -> None:
    await ws.send_text(json.dumps(message))


# ── Marketplace helpers ─────────────────────────────────────────────────────────────────
MERCHANT = {
    "business_name": "Sokha Coffee",
    "category": "food_drink",
    "contact_phone": "012 345 678",
    "business_address": "Street 136, Daun Penh",
    "operating_hours": {"mon": [["07:00", "20:00"]], "sat": [["08:00", "22:00"]]},
}


@pytest.fixture
async def clients() -> AsyncIterator[Any]:
    """Factory for extra signed-in clients (several players/merchants in one test)."""
    opened: list[httpx.AsyncClient] = []

    async def factory() -> httpx.AsyncClient:
        c = make_client()
        await c.__aenter__()
        opened.append(c)
        return c

    yield factory
    for c in opened:
        await c.__aexit__(None, None, None)


async def merchant_id_of(admin: httpx.AsyncClient, username: str) -> str:
    rows = (await admin.get("/admin/merchants", params={"status": "pending"})).json()
    return next(m["id"] for m in rows if m["owner_username"] == username)


async def approved_merchant(
    clients: Any, admin: httpx.AsyncClient, username: str, **merchant: Any
) -> httpx.AsyncClient:
    """A signed-in seller whose merchant application an administrator approved."""
    c = await clients()
    await onboard(c, username, roles=["buyer", "seller"])
    body = {**MERCHANT, "business_name": f"{username.title()} Shop", **merchant}
    response = await c.post("/merchant", json=body)
    assert response.status_code == 201, response.text
    mid = await merchant_id_of(admin, username)
    response = await admin.post(f"/admin/merchants/{mid}/approve", json={})
    assert response.status_code == 200, response.text
    return c


async def free_units(
    c: httpx.AsyncClient, count: int = 1, verification: bool = False
) -> list[dict]:
    """Available units near Central Market (optionally ones at real businesses)."""
    lat, lon = CENTRAL_MARKET
    bbox = f"{lon - 0.006},{lat - 0.006},{lon + 0.006},{lat + 0.006}"
    rows = (await c.get("/market/units", params={"bbox": bbox, "available": "true"})).json()
    picked = [u for u in rows if u["requires_verification"] == verification]
    assert len(picked) >= count, f"only {len(picked)} matching units"
    return picked[:count]


async def shop_with_products(
    clients: Any, admin: httpx.AsyncClient, username: str, products: list[dict]
) -> tuple[httpx.AsyncClient, dict, list[dict]]:
    """Approved merchant + claimed unit + products. Returns (client, shop, products)."""
    c = await approved_merchant(clients, admin, username)
    taken = {
        u["unit"]["code"]
        for u in (await admin.get("/admin/claims", params={"status": "approved"})).json()
    }
    unit = next(u for u in await free_units(c, 40) if u["code"] not in taken)
    response = await c.post("/merchant/claims", json={"unit_code": unit["code"]})
    assert response.status_code == 201, response.text
    shop = (await c.get("/merchant/shops")).json()[0]
    created = []
    for p in products:
        response = await c.post("/merchant/products", json={"category": "food", "stock": 10, **p})
        assert response.status_code == 201, response.text
        created.append(response.json())
    return c, shop, created
