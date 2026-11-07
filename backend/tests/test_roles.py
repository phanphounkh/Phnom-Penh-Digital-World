import httpx

from tests.conftest import make_client, register, register_verified


def status_of(me: dict, role: str) -> str | None:
    return next((r["status"] for r in me["roles"] if r["role"] == role), None)


async def test_roles_require_verified_contact(client: httpx.AsyncClient):
    await register(client)
    r = await client.post("/me/roles", json={"roles": ["buyer"]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "VERIFY_FIRST"


async def test_buyer_is_immediate_seller_and_driver_need_approval(client: httpx.AsyncClient):
    await register_verified(client)
    r = await client.post(
        "/me/roles",
        json={"roles": ["buyer", "seller", "driver"], "seller_note": "Noodle stall, Street 136"},
    )
    me = r.json()
    assert me["active_roles"] == ["buyer", "visitor"]
    assert status_of(me, "seller") == "pending"
    assert status_of(me, "driver") == "pending"
    assert me["onboarding"]["roles"] is True


async def test_visitor_only_is_a_valid_choice(client: httpx.AsyncClient):
    await register_verified(client)
    me = (await client.post("/me/roles", json={"roles": []})).json()
    assert me["active_roles"] == ["visitor"]
    assert me["onboarding"]["roles"] is True
    assert me["onboarding"]["needs_address"] is False


async def test_admin_role_cannot_be_self_assigned(client: httpx.AsyncClient):
    await register_verified(client)
    r = await client.post("/me/roles", json={"roles": ["admin"]})
    assert r.status_code == 422


async def test_unticking_a_role_withdraws_it(client: httpx.AsyncClient):
    await register_verified(client)
    await client.post("/me/roles", json={"roles": ["buyer", "seller"]})
    me = (await client.post("/me/roles", json={"roles": ["buyer"]})).json()
    assert status_of(me, "seller") == "revoked"
    assert me["active_roles"] == ["buyer", "visitor"]


async def test_non_admins_cannot_use_admin_endpoints(client: httpx.AsyncClient):
    await register_verified(client)
    await client.post("/me/roles", json={"roles": ["buyer", "seller"]})
    for method, path in (
        ("GET", "/admin/role-requests"),
        ("GET", "/admin/users"),
        ("POST", "/admin/role-requests/00000000-0000-0000-0000-000000000000/approve"),
    ):
        r = await client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 403, path
    async with make_client() as anonymous:
        assert (await anonymous.get("/admin/role-requests")).status_code == 401


async def test_admin_approves_and_rejects_requests(
    client: httpx.AsyncClient, admin_client: httpx.AsyncClient
):
    await register_verified(client, "seller1")
    await client.post("/me/roles", json={"roles": ["seller", "driver"]})
    pending = (await admin_client.get("/admin/role-requests")).json()
    assert {(p["username"], p["role"]) for p in pending} == {
        ("seller1", "seller"),
        ("seller1", "driver"),
    }
    seller = next(p for p in pending if p["role"] == "seller")
    driver = next(p for p in pending if p["role"] == "driver")

    ok = await admin_client.post(f"/admin/role-requests/{seller['id']}/approve", json={})
    assert ok.status_code == 200 and ok.json()["status"] == "active"
    no = await admin_client.post(
        f"/admin/role-requests/{driver['id']}/reject", json={"reason": "Licence photo unclear"}
    )
    assert no.json()["status"] == "rejected"
    twice = await admin_client.post(f"/admin/role-requests/{seller['id']}/approve", json={})
    assert twice.status_code == 409

    me = (await client.get("/auth/me")).json()
    assert "seller" in me["active_roles"] and "driver" not in me["active_roles"]
    assert next(r for r in me["roles"] if r["role"] == "driver")["decision_reason"] == (
        "Licence photo unclear"
    )

    # A rejected applicant may apply again; it goes back to the review queue.
    again = (await client.post("/me/roles", json={"roles": ["seller", "driver"]})).json()
    assert status_of(again, "driver") == "pending"
    assert status_of(again, "seller") == "active"


async def test_role_decisions_are_audited(
    client: httpx.AsyncClient, admin_client: httpx.AsyncClient
):
    from sqlalchemy import select

    from app.core.database import SessionLocal
    from app.models import AuditLog

    await register_verified(client, "seller1")
    await client.post("/me/roles", json={"roles": ["seller"]})
    request_id = (await admin_client.get("/admin/role-requests")).json()[0]["id"]
    await admin_client.post(f"/admin/role-requests/{request_id}/approve", json={})
    async with SessionLocal() as session:
        actions = (await session.scalars(select(AuditLog.action))).all()
    assert {"account.registered", "role.requested", "role.approved"} <= set(actions)
