import httpx

from tests.conftest import (
    AVATAR,
    CENTRAL_MARKET,
    SIEM_REAP,
    TOUL_KORK,
    first_spawn_id,
    onboard,
    register,
    register_verified,
)


async def test_full_onboarding_unlocks_world_bootstrap(client: httpx.AsyncClient):
    me = await onboard(client)
    assert me["onboarding"]["completed"] is True
    assert me["onboarding"]["next_step"] == "world"
    boot = (await client.get("/world/bootstrap")).json()
    assert boot["player"]["username"] == "sokha"
    assert boot["player"]["avatar"]["hair_style"] == "short"
    assert boot["player"]["world_visible"] is True
    spawn = boot["spawn"]
    assert spawn["region"] == "daun-penh-central"
    assert abs(spawn["x"]) < 2000 and abs(spawn["z"]) < 2000  # metres from the origin
    assert boot["config"]["crs"] == "EPSG:32648"


async def test_steps_are_enforced_in_order(client: httpx.AsyncClient):
    await register(client)
    r = await client.post("/me/onboarding/complete")
    assert r.status_code == 409 and r.json()["error"]["details"]["next_step"] == "verify"
    assert (await client.get("/world/bootstrap")).status_code == 409


async def test_buyers_need_a_private_address(client: httpx.AsyncClient):
    await register_verified(client)
    await client.put("/me/avatar", json=AVATAR)
    await client.post("/me/roles", json={"roles": ["buyer"]})
    spawn = {"spawn_point_id": await first_spawn_id(client), "world_visible": False}
    me = (await client.put("/me/spawn", json=spawn)).json()
    assert me["onboarding"]["needs_address"] is True
    assert me["onboarding"]["next_step"] == "location"
    lat, lon = CENTRAL_MARKET
    await client.post(
        "/me/addresses", json={"lat": lat, "lon": lon, "address_line": "St 130, Phsar Thmei"}
    )
    assert (await client.post("/me/onboarding/complete")).status_code == 200


async def test_visitors_can_finish_without_an_address(client: httpx.AsyncClient):
    me = await onboard(client, roles=[], visible=False)
    assert me["onboarding"]["completed"] is True
    assert me["world_visible"] is False


async def test_visibility_must_be_an_explicit_choice(client: httpx.AsyncClient):
    await register_verified(client)
    me = (await client.get("/auth/me")).json()
    assert me["world_visible"] is None  # not opted in by default
    r = await client.put("/me/spawn", json={"spawn_point_id": await first_spawn_id(client)})
    assert r.status_code == 422


async def test_addresses_must_be_inside_phnom_penh(client: httpx.AsyncClient):
    await register_verified(client)
    lat, lon = TOUL_KORK  # outside the playable area but inside the city: allowed
    ok = await client.post(
        "/me/addresses", json={"lat": lat, "lon": lon, "address_line": "Toul Kork"}
    )
    assert ok.status_code == 201
    lat, lon = SIEM_REAP
    far = await client.post(
        "/me/addresses", json={"lat": lat, "lon": lon, "address_line": "Siem Reap"}
    )
    assert far.status_code == 422 and far.json()["error"]["code"] == "OUTSIDE_SERVICE_AREA"


async def test_only_one_default_address(client: httpx.AsyncClient):
    await register_verified(client)
    lat, lon = CENTRAL_MARKET
    for label in ("Home", "Work"):
        body = {"label": label, "lat": lat, "lon": lon, "address_line": label, "is_default": True}
        assert (await client.post("/me/addresses", json=body)).status_code == 201
    addresses = (await client.get("/me/addresses")).json()
    assert [a["label"] for a in addresses if a["is_default"]] == ["Work"]


async def test_unknown_spawn_point_is_rejected(client: httpx.AsyncClient):
    await register_verified(client)
    r = await client.put(
        "/me/spawn",
        json={"spawn_point_id": "00000000-0000-0000-0000-000000000000", "world_visible": True},
    )
    assert r.status_code == 404


async def test_avatar_validation(client: httpx.AsyncClient):
    await register_verified(client)
    bad = [
        {**AVATAR, "top_color": "red"},
        {**AVATAR, "skin_tone": "#00ff00"},  # not an offered skin tone
        {**AVATAR, "hair_style": "mohawk"},
        {**AVATAR, "accessories": ["cap", "cap"]},
        {**AVATAR, "accessories": ["cap", "glasses", "backpack", "krama"]},
    ]
    for body in bad:
        assert (await client.put("/me/avatar", json=body)).status_code == 422, body
    saved = await client.put("/me/avatar", json={**AVATAR, "top_color": "#AABBCC"})
    assert saved.status_code == 200 and saved.json()["top_color"] == "#aabbcc"
    again = await client.put("/me/avatar", json={**AVATAR, "hair_style": "bun"})
    assert again.json()["hair_style"] == "bun"  # replaced, not duplicated
