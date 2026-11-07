import httpx

from tests.conftest import PASSWORD, adopt_csrf, make_client, register, registration


async def test_register_creates_session_visitor_role_and_verification(client: httpx.AsyncClient):
    body = await register(client, "sokha")
    user = body["user"]
    assert user["username"] == "sokha"
    assert user["active_roles"] == ["visitor"]
    assert user["email_verified"] is False
    assert user["onboarding"]["next_step"] == "verify"
    verification = body["verification"]
    assert verification["channel"] == "email"
    assert verification["destination"] == "s***@example.com"
    assert len(verification["dev_code"]) == 6  # development only, clearly labelled in the UI
    assert "ppw_session" in client.cookies
    me = await client.get("/auth/me")
    assert me.status_code == 200 and me.json()["username"] == "sokha"


async def test_register_normalises_username_and_cambodian_phone(client: httpx.AsyncClient):
    response = await client.post(
        "/auth/register",
        json=registration("Dara.K", email=None, phone="012 345 678"),
    )
    assert response.status_code == 201, response.text
    user = response.json()["user"]
    assert user["username"] == "dara.k"
    assert user["phone"] == "+85512345678"
    assert response.json()["verification"]["channel"] == "phone"


async def test_register_rejects_duplicates(client: httpx.AsyncClient):
    await register(client, "sokha")
    async with make_client() as other:
        same_name = await other.post(
            "/auth/register", json=registration("sokha", email="x@example.com")
        )
        same_email = await other.post(
            "/auth/register", json=registration("sokha2", email="sokha@example.com")
        )
    assert same_name.status_code == 409 and same_name.json()["error"]["code"] == "ACCOUNT_EXISTS"
    assert same_email.status_code == 409


async def test_register_validation(client: httpx.AsyncClient):
    cases = [
        registration("ab"),  # too short
        registration("admin"),  # reserved
        registration("sokha", email=None),  # no contact at all
        registration("sokha", password="aaaaaaaaaaaa"),  # guessable
        registration("sokha", accept_terms=False),  # must accept terms
        registration("sokha", preferred_language="fr"),
    ]
    from app.core.rate_limit import limiter

    for body in cases:
        limiter.reset()  # invalid attempts count towards the register rate limit too
        response = await client.post("/auth/register", json=body)
        assert response.status_code == 422, body


async def test_password_is_hashed_with_argon2(client: httpx.AsyncClient):
    from sqlalchemy import select

    from app.core.database import SessionLocal
    from app.models import User

    await register(client, "sokha")
    async with SessionLocal() as session:
        stored = await session.scalar(select(User.password_hash).where(User.username == "sokha"))
    assert stored.startswith("$argon2id$") and PASSWORD not in stored


async def test_login_with_username_email_or_phone(client: httpx.AsyncClient):
    await client.post("/auth/register", json=registration("sokha", phone="+855 12 345 678"))
    for identifier in ("sokha", "SOKHA@example.com", "012 345 678", "+85512345678"):
        async with make_client() as c:
            r = await c.post("/auth/login", json={"identifier": identifier, "password": PASSWORD})
            assert r.status_code == 200, (identifier, r.text)


async def test_login_wrong_password_is_generic(client: httpx.AsyncClient):
    await register(client, "sokha")
    async with make_client() as c:
        wrong = await c.post("/auth/login", json={"identifier": "sokha", "password": "nope-nope"})
        unknown = await c.post("/auth/login", json={"identifier": "ghost", "password": PASSWORD})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


async def test_login_is_rate_limited_per_account(client: httpx.AsyncClient):
    await register(client, "sokha")
    from app.core.rate_limit import limiter

    statuses = []
    for _ in range(12):
        limiter._hits.pop("login:127.0.0.1", None)  # isolate the per-account limit
        async with make_client() as c:
            r = await c.post("/auth/login", json={"identifier": "sokha", "password": "bad-guess"})
            statuses.append(r.status_code)
    assert statuses[:10] == [401] * 10
    assert statuses[10:] == [429, 429]


async def test_logout_revokes_the_server_side_session(client: httpx.AsyncClient):
    await register(client, "sokha")
    stolen = client.cookies["ppw_session"]
    assert (await client.post("/auth/logout")).status_code == 200
    assert (await client.get("/auth/me")).status_code == 401
    # Replaying the old cookie must not work: the session row is revoked.
    async with make_client() as attacker:
        attacker.cookies.set("ppw_session", stolen)
        assert (await attacker.get("/auth/me")).status_code == 401


async def test_sessions_can_be_listed_and_revoked(client: httpx.AsyncClient):
    await register(client, "sokha")
    async with make_client() as laptop:
        await laptop.post("/auth/login", json={"identifier": "sokha", "password": PASSWORD})
        sessions = (await client.get("/auth/sessions")).json()
        assert len(sessions) == 2
        other = next(s for s in sessions if not s["current"])
        assert (await client.delete(f"/auth/sessions/{other['id']}")).status_code == 200
        assert (await laptop.get("/auth/me")).status_code == 401
    assert (await client.get("/auth/me")).status_code == 200


async def test_state_changes_require_csrf_token(client: httpx.AsyncClient):
    await register(client, "sokha")
    del client.headers["X-CSRF-Token"]
    r = await client.patch("/me/profile", json={"display_name": "Changed"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "CSRF_FAILED"
    adopt_csrf(client)
    assert (await client.patch("/me/profile", json={"display_name": "Changed"})).status_code == 200


async def test_cross_origin_writes_are_blocked(client: httpx.AsyncClient):
    r = await client.post(
        "/auth/register", json=registration("sokha"), headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403


async def test_tampered_token_is_rejected(client: httpx.AsyncClient):
    await register(client, "sokha")
    token = client.cookies["ppw_session"]
    client.cookies.set("ppw_session", token[:-2] + ("AA" if not token.endswith("AA") else "BB"))
    assert (await client.get("/auth/me")).status_code == 401
