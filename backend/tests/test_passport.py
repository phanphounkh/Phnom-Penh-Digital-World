import asyncio

from tests.conftest import PASSWORD, adopt_csrf, make_client, register


async def test_passport_requires_authentication(client):
    assert (await client.get("/me/passport")).status_code == 401


async def test_passport_merges_and_isolates_accounts(client):
    await register(client, "explorer")
    assert (await client.get("/me/passport")).json() == {
        "version": 1,
        "stamps": [],
        "delivered": False,
    }
    assert (
        await client.post("/me/passport", json={"stamps": ["wat-phnom"], "delivered": True})
    ).status_code == 200
    # A fresh browser has cookies but no local-storage passport.
    async with make_client() as second:
        assert (
            await second.post("/auth/login", json={"identifier": "explorer", "password": PASSWORD})
        ).status_code == 200
        adopt_csrf(second)
        result = await second.post("/me/passport", json={"stamps": ["canadia-garden"]})
        assert result.json()["stamps"] == ["wat-phnom", "canadia-garden"]
        assert result.json()["delivered"] is True
        result = await client.post("/me/passport", json={"stamps": [], "delivered": False})
        assert result.json()["stamps"] == ["wat-phnom", "canadia-garden"]
        assert result.json()["delivered"] is True
    async with make_client() as other:
        await register(other, "another_explorer")
        assert (await other.get("/me/passport")).json()["stamps"] == []
    for body in [
        {"stamps": ["invented"]},
        {"delivered": "true"},
        {"user_id": "other"},
        {"version": 2},
        {"stamps": ["wat-phnom"] * 4},
    ]:
        assert (await client.post("/me/passport", json=body)).status_code == 422
    client.headers.pop("X-CSRF-Token")
    assert (await client.post("/me/passport", json={"stamps": []})).status_code == 403


async def test_concurrent_first_saves_union_discoveries(client):
    await register(client, "parallel_explorer")
    async with make_client() as second:
        await second.post(
            "/auth/login", json={"identifier": "parallel_explorer", "password": PASSWORD}
        )
        adopt_csrf(second)
        results = await asyncio.gather(
            client.post("/me/passport", json={"stamps": ["wat-phnom"]}),
            second.post("/me/passport", json={"stamps": ["central-market"], "delivered": True}),
        )
        assert all(result.status_code == 200 for result in results)
    state = (await client.get("/me/passport")).json()
    assert state["stamps"] == ["wat-phnom", "central-market"]
    assert state["delivered"] is True
