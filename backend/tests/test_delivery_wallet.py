"""Delivery authorization/races and atomic demo credit accounting, on real PostgreSQL."""

import asyncio
import uuid

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.core.database import SessionLocal
from app.models import Inventory, LedgerEntry, LedgerTransaction
from app.multiplayer.hub import hub
from tests.conftest import expect, onboard, shop_with_products, world_socket

ITEM = {"name": "Delivery noodles", "price_minor": 250, "fulfillment": ["pickup", "delivery"]}


async def driver(clients, admin, name):
    client = await clients()
    me = await onboard(client, name, roles=["driver"])
    requests = (await admin.get("/admin/role-requests")).json()
    row = next(row for row in requests if row["username"] == name and row["role"] == "driver")
    assert (
        await admin.post(f"/admin/role-requests/{row['id']}/approve", json={})
    ).status_code == 200
    assert (await client.put("/driver/availability", json={"online": True})).status_code == 200
    return client, uuid.UUID(me["id"])


async def order_setup(clients, admin, *, delivery=True, price=250):
    seller, shop, (item,) = await shop_with_products(
        clients, admin, "delivery_shop", [{**ITEM, "price_minor": price}]
    )
    buyer = await clients()
    await onboard(buyer, "delivery_buyer")
    assert (
        await buyer.post("/cart/items", json={"product_id": item["id"], "shop_id": shop["id"]})
    ).status_code == 200
    spawn = (await buyer.get("/geo/spawn-points")).json()[0]
    body = {
        "expected_total_minor": price + (150 if delivery else 0),
        "fulfillment": "delivery" if delivery else "pickup",
        "dropoff_spawn_id": spawn["id"],
    }
    response = await buyer.post(
        "/checkout", json=body, headers={"Idempotency-Key": "delivery-checkout"}
    )
    assert response.status_code == 201, response.text
    payment = response.json()
    assert (await buyer.post(f"/payments/{payment['id']}/confirm")).status_code == 200
    order = payment["orders"][0]
    for status in ["merchant_accepted", "preparing", "ready_for_pickup"]:
        response = await seller.post(
            f"/merchant/orders/{order['id']}/transition", json={"to": status}
        )
        assert response.status_code == 200, response.text
    return seller, buyer, order, payment


async def test_checkout_enforces_product_fulfillment(clients, admin_client):
    _, shop, (item,) = await shop_with_products(
        clients, admin_client, "delivery_only", [{**ITEM, "fulfillment": ["delivery"]}]
    )
    buyer = await clients()
    await onboard(buyer, "pickup_buyer")
    await buyer.post("/cart/items", json={"product_id": item["id"], "shop_id": shop["id"]})
    response = await buyer.post(
        "/checkout", json={"expected_total_minor": 250}, headers={"Idempotency-Key": "wrong-method"}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FULFILLMENT_UNAVAILABLE"
    async with SessionLocal() as session:
        assert (await session.get(Inventory, uuid.UUID(item["id"]))).on_hand == 10
    response = await buyer.post(
        "/checkout",
        json={"fulfillment": "delivery", "expected_total_minor": 400},
        headers={"Idempotency-Key": "missing-dropoff"},
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "DROPOFF_REQUIRED"
    spawn = (await buyer.get("/geo/spawn-points")).json()[0]
    response = await buyer.post(
        "/checkout",
        json={
            "fulfillment": "delivery",
            "dropoff_spawn_id": spawn["id"],
            "expected_total_minor": 250,
        },
        headers={"Idempotency-Key": "missing-fee"},
    )
    assert response.status_code == 409 and response.json()["error"]["code"] == "PRICE_CHANGED"


async def test_demo_credits_are_idempotent_under_concurrency(client):
    await onboard(client, "wallet_user")
    assert (await client.get("/wallet")).json()["balance_minor"] == 10_000

    async def credit(amount=5000):
        return await client.post(
            "/wallet/credits",
            json={"amount_minor": amount},
            headers={"Idempotency-Key": "same-credit-key"},
        )

    responses = await asyncio.gather(credit(), credit())
    assert all(response.status_code == 200 for response in responses)
    assert (await client.get("/wallet")).json()["balance_minor"] == 15_000
    assert (await credit(6000)).status_code == 409
    async with SessionLocal() as session:
        assert await session.scalar(select(func.sum(LedgerEntry.amount_minor))) == 0
        assert await session.scalar(select(func.count()).select_from(LedgerTransaction)) == 2


async def test_payment_refund_and_merchant_settlement(clients, admin_client):
    seller, buyer, order, payment = await order_setup(clients, admin_client, delivery=False)
    twins = await asyncio.gather(
        *[buyer.post(f"/payments/{payment['id']}/confirm") for _ in range(2)]
    )
    assert all(response.status_code == 200 for response in twins)
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 9750
    assert (
        await seller.post(f"/merchant/orders/{order['id']}/transition", json={"to": "completed"})
    ).status_code == 200
    assert (await seller.get("/wallet")).json()["balance_minor"] == 10_250
    async with SessionLocal() as session:
        assert await session.scalar(select(func.sum(LedgerEntry.amount_minor))) == 0


async def test_insufficient_balance_does_not_mark_payment_paid(clients, admin_client):
    _, shop, (item,) = await shop_with_products(
        clients, admin_client, "expensive_shop", [{**ITEM, "price_minor": 20_000}]
    )
    buyer = await clients()
    await onboard(buyer, "poor_buyer")
    await buyer.post("/cart/items", json={"product_id": item["id"], "shop_id": shop["id"]})
    payment = (
        await buyer.post(
            "/checkout",
            json={"expected_total_minor": 20_000},
            headers={"Idempotency-Key": "expensive-checkout"},
        )
    ).json()
    response = await buyer.post(f"/payments/{payment['id']}/confirm")
    assert response.status_code == 409 and response.json()["error"]["code"] == "INSUFFICIENT_FUNDS"
    assert (await buyer.get(f"/payments/{payment['id']}")).json()[
        "status"
    ] == "requires_confirmation"
    await buyer.post(
        "/wallet/credits",
        json={"amount_minor": 20_000},
        headers={"Idempotency-Key": "more-demo-credit"},
    )
    assert (await buyer.post(f"/payments/{payment['id']}/confirm")).status_code == 200
    order_id = payment["orders"][0]["id"]
    assert (await buyer.post(f"/orders/{order_id}/cancel", json={})).status_code == 200
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 30_000
    assert (await buyer.post(f"/orders/{order_id}/cancel", json={})).status_code == 409


async def test_database_refuses_unbalanced_or_mutated_journal(client):
    await onboard(client, "ledger_user")
    await client.get("/wallet")
    async with SessionLocal() as session:
        session.add(LedgerTransaction(reference="missing-entries", kind="test", amount_minor=100))
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()
        with pytest.raises(IntegrityError):
            await session.execute(update(LedgerEntry).values(amount_minor=1))
        await session.rollback()


async def test_only_one_driver_wins_and_release_reopens_job(clients, admin_client):
    seller, buyer, order, _ = await order_setup(clients, admin_client)
    a, _ = await driver(clients, admin_client, "driver_a")
    b, _ = await driver(clients, admin_client, "driver_b")
    job = (await a.get("/driver")).json()["offers"][0]
    response_a, response_b = await asyncio.gather(
        a.post(f"/driver/jobs/{job['id']}/accept"), b.post(f"/driver/jobs/{job['id']}/accept")
    )
    assert sorted([response_a.status_code, response_b.status_code]) == [200, 409]
    winner = a if response_a.status_code == 200 else b
    loser = b if winner is a else a
    assert (await loser.post(f"/driver/jobs/{job['id']}/pickup")).status_code == 404
    assert (await loser.get(f"/orders/{order['id']}/delivery")).status_code == 404
    assert (await buyer.post(f"/orders/{order['id']}/received")).status_code == 409
    assert (await winner.post(f"/driver/jobs/{job['id']}/release")).status_code == 200
    assert (await buyer.get(f"/orders/{order['id']}")).json()["status"] == "ready_for_pickup"
    assert (
        await seller.post(f"/merchant/orders/{order['id']}/transition", json={"to": "refunded"})
    ).status_code == 200
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 10_000
    assert not (await loser.get("/driver")).json()["offers"]


async def test_delivery_checks_position_survives_disconnect_and_settles(clients, admin_client):
    seller, buyer, order, _ = await order_setup(clients, admin_client)
    courier, user_id = await driver(clients, admin_client, "courier")
    job = (await courier.get("/driver")).json()["offers"][0]
    assert (await courier.post(f"/driver/jobs/{job['id']}/accept")).status_code == 200
    assert (await courier.post(f"/driver/jobs/{job['id']}/pickup")).status_code == 409
    async with world_socket(courier) as socket:
        await expect(socket, "welcome")
        player = hub.by_user[user_id]
        player.x, player.z = job["pickup"]["x"] + 100, job["pickup"]["z"]
        assert (await courier.post(f"/driver/jobs/{job['id']}/pickup")).status_code == 409
        player.x, player.z = job["pickup"]["x"], job["pickup"]["z"]
        assert (await courier.post(f"/driver/jobs/{job['id']}/pickup")).status_code == 200
        assert (await courier.post(f"/driver/jobs/{job['id']}/release")).status_code == 409
    await asyncio.sleep(0.05)
    track = (await buyer.get(f"/orders/{order['id']}/delivery")).json()
    assert track["status"] == "picked_up" and track["position"] is None
    assert "address" not in str(track) and "username" not in str(track)
    async with world_socket(courier) as socket:
        await expect(socket, "welcome")
        assert (await courier.post(f"/driver/jobs/{job['id']}/start")).status_code == 200
        player = hub.by_user[user_id]
        player.x, player.z = job["dropoff"]["x"], job["dropoff"]["z"]
        assert (await courier.post(f"/driver/jobs/{job['id']}/deliver")).status_code == 200
        assert (await courier.post(f"/driver/jobs/{job['id']}/deliver")).status_code == 200
    assert (await buyer.get(f"/orders/{order['id']}")).json()["status"] == "completed"
    assert (await courier.get("/wallet")).json()["balance_minor"] == 10_150
    assert (await seller.get("/wallet")).json()["balance_minor"] == 10_250
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 9600


async def test_unapproved_driver_cannot_go_online(client):
    await onboard(client, "pending_driver", roles=["driver"])
    assert (await client.put("/driver/availability", json={"online": True})).status_code == 403


async def test_one_driver_cannot_claim_two_orders(clients, admin_client):
    seller, buyer, _, _ = await order_setup(clients, admin_client)
    courier, _ = await driver(clients, admin_client, "busy_driver")
    products = (await seller.get("/merchant/products")).json()
    shops = (await seller.get("/merchant/shops")).json()
    await buyer.post(
        "/cart/items", json={"product_id": products[0]["id"], "shop_id": shops[0]["id"]}
    )
    spawn = (await buyer.get("/geo/spawn-points")).json()[0]
    payment = (
        await buyer.post(
            "/checkout",
            json={
                "expected_total_minor": 400,
                "fulfillment": "delivery",
                "dropoff_spawn_id": spawn["id"],
            },
            headers={"Idempotency-Key": "second-delivery"},
        )
    ).json()
    await buyer.post(f"/payments/{payment['id']}/confirm")
    order = payment["orders"][0]
    for to in ["merchant_accepted", "preparing", "ready_for_pickup"]:
        await seller.post(f"/merchant/orders/{order['id']}/transition", json={"to": to})
    offers = (await courier.get("/driver")).json()["offers"]
    responses = await asyncio.gather(
        *[courier.post(f"/driver/jobs/{job['id']}/accept") for job in offers]
    )
    assert sorted(response.status_code for response in responses) == [200, 409]
    operations = (await admin_client.get("/admin/operations")).json()
    assert operations["counts"]["active_deliveries"] == 1
    assert operations["counts"]["wallet_mismatches"] == 0
    assert operations["counts"]["journal_total_minor"] == 0
    job = operations["deliveries"][0]
    assert (await buyer.get("/admin/operations")).status_code == 403
    response = await admin_client.post(
        f"/admin/deliveries/{job['id']}/refund",
        json={"reason": "Driver cannot complete this simulated delivery"},
    )
    assert response.status_code == 200, response.text
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 9600


async def test_payment_confirmation_racing_cancellation_does_not_deadlock(clients, admin_client):
    _, shop, (item,) = await shop_with_products(clients, admin_client, "race_payment_shop", [ITEM])
    buyer = await clients()
    await onboard(buyer, "race_payment_buyer")
    await buyer.post("/cart/items", json={"product_id": item["id"], "shop_id": shop["id"]})
    payment = (
        await buyer.post(
            "/checkout",
            json={"expected_total_minor": 250},
            headers={"Idempotency-Key": "race-payment-key"},
        )
    ).json()
    order_id = payment["orders"][0]["id"]
    confirmation, cancellation = await asyncio.wait_for(
        asyncio.gather(
            buyer.post(f"/payments/{payment['id']}/confirm"),
            buyer.post(f"/orders/{order_id}/cancel", json={}),
        ),
        timeout=10,
    )
    assert confirmation.status_code in (200, 409)
    assert cancellation.status_code == 200
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 10_000
    assert (await buyer.get(f"/orders/{order_id}")).json()["status"] in ("cancelled", "refunded")
