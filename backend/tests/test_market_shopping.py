"""Phase 4: catalogue rules, cart pricing, multi-merchant checkout, idempotency, the demo
payment (never twice), order state machine, refunds, access control and revenue."""

import asyncio
from datetime import timedelta

from sqlalchemy import func, select, update

from app.core.database import SessionLocal
from app.marketplace import checkout as checkout_service
from app.models import AuditLog, Inventory, OrderEvent, PaymentIntent, Refund
from app.utils.time import utcnow
from tests.conftest import onboard, shop_with_products

NOODLES = {"name": "Kuy teav", "name_km": "គុយទាវ", "price_minor": 250, "model": "noodles"}
COFFEE = {"name": "Iced coffee", "price_minor": 150, "model": "coffee", "category": "drinks"}
BOOK = {"name": "Khmer phrasebook", "price_minor": 899, "model": "book", "category": "books"}


async def buyer(clients, name: str = "buyer_bo"):
    c = await clients()
    await onboard(c, name, roles=["buyer"])
    return c


async def stock_of(product_id: str) -> int:
    async with SessionLocal() as session:
        return (await session.get(Inventory, product_id)).on_hand


async def checkout(c, key: str, **body):
    cart = (await c.get("/cart")).json()
    payload = {"expected_total_minor": cart["total_minor"], **body}
    return await c.post("/checkout", json=payload, headers={"Idempotency-Key": key})


# ── catalogue ────────────────────────────────────────────────────────────────────────


async def test_catalogue_rules_and_storefront(clients, admin_client):
    seller, shop, (noodles, _coffee) = await shop_with_products(
        clients, admin_client, "noodle_nary", [NOODLES, COFFEE]
    )
    banned = await seller.post(
        "/merchant/products", json={"name": "Vape pen", "category": "tobacco", "price_minor": 900}
    )
    assert banned.status_code == 422 and banned.json()["error"]["code"] == "PROHIBITED_CATEGORY"
    beer = await seller.post(
        "/merchant/products",
        json={"name": "Angkor beer", "category": "alcohol", "price_minor": 125, "stock": 24},
    )
    assert beer.status_code == 201 and beer.json()["status"] == "pending_review"
    hidden = await seller.post("/merchant/products", json={**BOOK, "visible": False, "stock": 2})
    assert hidden.json()["status"] == "hidden"

    # The 3D city sees the storefront and only purchasable products.
    world = (await seller.get("/market/shops")).json()
    assert [s["id"] for s in world] == [shop["id"]]
    assert len(world[0]["unit"]["corners"]) == 4 and world[0]["owner_username"] == "noodle_nary"
    detail = (await seller.get(f"/market/shops/{shop['id']}")).json()
    assert [p["name"] for p in detail["products"]] == ["Kuy teav", "Iced coffee"]

    # Restricted listing becomes visible only after an administrator approves it.
    queue = (await admin_client.get("/admin/products")).json()
    assert [p["name"] for p in queue] == ["Angkor beer"]
    await admin_client.post(f"/admin/products/{beer.json()['id']}/approve", json={})
    detail = (await seller.get(f"/market/shops/{shop['id']}")).json()
    assert "Angkor beer" in [p["name"] for p in detail["products"]]
    beer_out = next(p for p in detail["products"] if p["name"] == "Angkor beer")
    assert beer_out["min_age"] == 18

    # Another merchant cannot touch these products; customising the shop works.
    other, _, _ = await shop_with_products(clients, admin_client, "other_ou", [])
    assert (
        await other.patch(f"/merchant/products/{noodles['id']}", json={"price_minor": 1})
    ).status_code == 404
    assert (
        await other.patch(f"/merchant/shops/{shop['id']}", json={"name": "Mine"})
    ).status_code == 404
    custom = await seller.patch(
        f"/merchant/shops/{shop['id']}",
        json={"name": "Nary's Noodles", "theme": "cafe", "primary_color": "#2F6F8F"},
    )
    assert custom.status_code == 200 and custom.json()["primary_color"] == "#2f6f8f"
    bad = await seller.patch(f"/merchant/shops/{shop['id']}", json={"primary_color": "blue"})
    assert bad.status_code == 422


# ── cart ─────────────────────────────────────────────────────────────────────────────


async def test_cart_reprices_and_checks_stock(clients, admin_client):
    seller, shop, (noodles, coffee) = await shop_with_products(
        clients, admin_client, "cart_chan", [NOODLES, COFFEE]
    )
    visitor = await clients()
    await onboard(visitor, "just_looking", roles=[])
    denied = await visitor.post("/cart/items", json={"product_id": noodles["id"]})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "BUYER_ROLE_REQUIRED"
    own = await seller.post("/cart/items", json={"product_id": noodles["id"]})
    assert own.status_code == 400

    b = await buyer(clients)
    cart = (
        await b.post(
            "/cart/items", json={"product_id": noodles["id"], "quantity": 2, "shop_id": shop["id"]}
        )
    ).json()
    cart = (await b.post("/cart/items", json={"product_id": coffee["id"]})).json()
    assert cart["total_minor"] == 2 * 250 + 150 and cart["item_count"] == 3
    too_many = await b.post("/cart/items", json={"product_id": coffee["id"], "quantity": 10})
    assert too_many.status_code == 409 and too_many.json()["error"]["code"] == "INSUFFICIENT_STOCK"

    # The seller raises a price: the cart shows the change and the new total.
    await seller.patch(f"/merchant/products/{noodles['id']}", json={"price_minor": 300})
    cart = (await b.get("/cart")).json()
    line = next(x for x in cart["groups"][0]["lines"] if x["name"] == "Kuy teav")
    assert line["price_changed"] and line["quoted_price_minor"] == 250
    assert cart["total_minor"] == 2 * 300 + 150

    # Stock runs out under the buyer: the line is flagged and checkout is blocked.
    await seller.put(f"/merchant/products/{coffee['id']}/stock", json={"on_hand": 0})
    cart = (await b.get("/cart")).json()
    assert not cart["can_checkout"]
    response = await checkout(b, "key-out-of-stock")
    assert response.status_code == 409 and response.json()["error"]["code"] == "ITEMS_UNAVAILABLE"
    cart = (await b.delete(f"/cart/items/{coffee['id']}")).json()
    assert cart["can_checkout"] and cart["total_minor"] == 600


# ── checkout and payment ─────────────────────────────────────────────────────────────


async def test_multi_merchant_checkout_is_server_priced_and_idempotent(clients, admin_client):
    _, shop_a, (noodles,) = await shop_with_products(clients, admin_client, "merch_a", [NOODLES])
    _, _, (book,) = await shop_with_products(clients, admin_client, "merch_b", [BOOK])
    b = await buyer(clients)
    await b.post(
        "/cart/items", json={"product_id": noodles["id"], "quantity": 2, "shop_id": shop_a["id"]}
    )
    await b.post("/cart/items", json={"product_id": book["id"]})

    no_key = await b.post("/checkout", json={"expected_total_minor": 1399})
    assert (
        no_key.status_code == 400 and no_key.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"
    )
    # A client that sends the wrong (stale or tampered) total is refused.
    wrong = await b.post(
        "/checkout", json={"expected_total_minor": 100}, headers={"Idempotency-Key": "tamper-001"}
    )
    assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "PRICE_CHANGED"
    assert wrong.json()["error"]["details"]["actual_total_minor"] == 2 * 250 + 899

    first = await checkout(b, "checkout-0001")
    assert first.status_code == 201, first.text
    intent = first.json()
    assert intent["status"] == "requires_confirmation" and intent["is_demo"]
    assert intent["amount_minor"] == 1399
    orders = {o["merchant_name"]: o for o in intent["orders"]}
    assert set(orders) == {"Merch_A Shop", "Merch_B Shop"}  # one order per merchant
    assert orders["Merch_A Shop"]["total_minor"] == 500 and orders["Merch_A Shop"]["pickup_unit"]
    assert all(o["status"] == "pending_payment" for o in intent["orders"])
    assert await stock_of(noodles["id"]) == 8  # reserved
    assert (await b.get("/cart")).json()["item_count"] == 0

    # Retrying the same request (e.g. after a network error) returns the same checkout.
    retry = await b.post(
        "/checkout",
        json={"expected_total_minor": 1399},
        headers={"Idempotency-Key": "checkout-0001"},
    )
    assert retry.status_code == 201 and retry.json()["id"] == intent["id"]
    assert [o["id"] for o in retry.json()["orders"]] == [o["id"] for o in intent["orders"]]
    reuse = await b.post(
        "/checkout",
        json={"expected_total_minor": 999},
        headers={"Idempotency-Key": "checkout-0001"},
    )
    assert reuse.status_code == 409 and reuse.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(PaymentIntent)) == 1


async def test_payment_cannot_be_completed_twice(clients, admin_client):
    _, _, (noodles,) = await shop_with_products(clients, admin_client, "pay_merch", [NOODLES])
    b = await buyer(clients)
    await b.post("/cart/items", json={"product_id": noodles["id"], "quantity": 3})
    intent = (await checkout(b, "pay-twice-01")).json()

    # Five confirmations at once: one succeeds, the rest report the same result.
    results = await asyncio.gather(*(b.post(f"/payments/{intent['id']}/confirm") for _ in range(5)))
    assert all(r.status_code == 200 for r in results), [r.text for r in results]
    assert sorted(r.json()["already_confirmed"] for r in results) == [False, True, True, True, True]
    references = {r.json()["reference"] for r in results}
    assert len(references) == 1 and next(iter(references)).startswith("DEMO-")
    again = await b.post(f"/payments/{intent['id']}/confirm")
    assert again.json()["already_confirmed"] and again.json()["orders"][0]["status"] == "paid"
    async with SessionLocal() as session:
        paid_events = await session.scalar(
            select(func.count()).select_from(OrderEvent).where(OrderEvent.to_status == "paid")
        )
        audits = await session.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == "payment.succeeded")
        )
    assert paid_events == 1 and audits == 1
    assert await stock_of(noodles["id"]) == 7  # decremented once


async def test_users_cannot_touch_other_peoples_payments_or_orders(clients, admin_client):
    seller, _, (noodles,) = await shop_with_products(
        clients, admin_client, "guard_merch", [NOODLES]
    )
    owner = await buyer(clients, "owner_oun")
    intruder = await buyer(clients, "intruder_ith")
    await owner.post("/cart/items", json={"product_id": noodles["id"]})
    intent = (await checkout(owner, "owner-checkout")).json()
    order_id = intent["orders"][0]["id"]

    assert (await intruder.get(f"/payments/{intent['id']}")).status_code == 404
    assert (await intruder.post(f"/payments/{intent['id']}/confirm")).status_code == 404
    assert (await intruder.post(f"/payments/{intent['id']}/cancel")).status_code == 404
    assert (await intruder.get(f"/orders/{order_id}")).status_code == 404
    assert (await intruder.post(f"/orders/{order_id}/cancel", json={})).status_code == 404
    hijack = await intruder.post(f"/merchant/orders/{order_id}/transition", json={"to": "refunded"})
    assert hijack.status_code in (404,)
    # The buyer cannot act as the merchant either.
    await owner.post(f"/payments/{intent['id']}/confirm")
    self_accept = await owner.post(
        f"/merchant/orders/{order_id}/transition", json={"to": "merchant_accepted"}
    )
    assert self_accept.status_code == 404
    assert (await intruder.get("/orders")).json() == []
    assert len((await seller.get("/merchant/orders")).json()) == 1
    assert (await seller.get("/merchant/orders")).json()[0]["buyer_username"] == "owner_oun"


async def test_order_lifecycle_refunds_and_revenue(clients, admin_client):
    seller, _, (noodles, coffee) = await shop_with_products(
        clients, admin_client, "life_merch", [NOODLES, COFFEE]
    )
    b = await buyer(clients)
    await b.post("/cart/items", json={"product_id": noodles["id"], "quantity": 2})
    first = (await checkout(b, "life-0001")).json()
    await b.post(f"/payments/{first['id']}/confirm")
    order_id = first["orders"][0]["id"]

    skip = await seller.post(f"/merchant/orders/{order_id}/transition", json={"to": "completed"})
    assert skip.status_code == 409 and skip.json()["error"]["code"] == "INVALID_TRANSITION"
    assert skip.json()["error"]["details"]["allowed"] == ["merchant_accepted", "refunded"]
    for step in ("merchant_accepted", "preparing", "ready_for_pickup"):
        response = await seller.post(f"/merchant/orders/{order_id}/transition", json={"to": step})
        assert response.status_code == 200, response.text
    collected = await b.post(f"/orders/{order_id}/received")
    assert collected.json()["status"] == "completed"
    history = [e["to_status"] for e in collected.json()["events"]]
    assert history == [
        "pending_payment",
        "paid",
        "merchant_accepted",
        "preparing",
        "ready_for_pickup",
        "completed",
    ]

    # Second order: the buyer cancels after paying, which issues a (demo) refund once.
    await b.post("/cart/items", json={"product_id": coffee["id"], "quantity": 4})
    second = (await checkout(b, "life-0002")).json()
    await b.post(f"/payments/{second['id']}/confirm")
    assert await stock_of(coffee["id"]) == 6
    cancelled = await b.post(
        f"/orders/{second['orders'][0]['id']}/cancel", json={"reason": "Changed my mind"}
    )
    assert cancelled.json()["status"] == "refunded" and cancelled.json()["refunded_minor"] == 600
    assert await stock_of(coffee["id"]) == 10  # back on the shelf
    twice = await b.post(f"/orders/{second['orders'][0]['id']}/cancel", json={})
    assert twice.status_code == 409
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Refund)) == 1

    revenue = (await seller.get("/merchant/revenue")).json()
    assert revenue["total_revenue_minor"] == 500 and revenue["total_orders"] == 1
    assert revenue["refunded_minor"] == 600 and revenue["is_demo"]


async def test_unpaid_checkout_expires_and_releases_stock(clients, admin_client):
    _, _, (noodles,) = await shop_with_products(clients, admin_client, "exp_merch", [NOODLES])
    b = await buyer(clients)
    await b.post("/cart/items", json={"product_id": noodles["id"], "quantity": 4})
    intent = (await checkout(b, "expire-0001")).json()
    assert await stock_of(noodles["id"]) == 6
    async with SessionLocal() as session:
        await session.execute(
            update(PaymentIntent)
            .where(PaymentIntent.id == intent["id"])
            .values(expires_at=utcnow() - timedelta(seconds=1))
        )
        await session.commit()
    late = await b.post(f"/payments/{intent['id']}/confirm")
    assert late.status_code == 409 and late.json()["error"]["code"] == "PAYMENT_EXPIRED"
    view = (await b.get(f"/payments/{intent['id']}")).json()
    assert view["status"] == "expired" and view["orders"][0]["status"] == "cancelled"
    assert await stock_of(noodles["id"]) == 10
    async with SessionLocal() as session:
        assert await checkout_service.expire_due_payments(session) == 0  # nothing left to do


async def test_age_restricted_items_need_confirmation(clients, admin_client):
    seller, _, _ = await shop_with_products(clients, admin_client, "bar_merch", [])
    beer = (
        await seller.post(
            "/merchant/products",
            json={"name": "Angkor beer", "category": "alcohol", "price_minor": 125, "stock": 5},
        )
    ).json()
    await admin_client.post(f"/admin/products/{beer['id']}/approve", json={})
    b = await buyer(clients)
    cart = (await b.post("/cart/items", json={"product_id": beer["id"]})).json()
    assert cart["needs_age_confirmation"]
    refused = await checkout(b, "age-0001")
    assert (
        refused.status_code == 422
        and refused.json()["error"]["code"] == "AGE_CONFIRMATION_REQUIRED"
    )
    assert (await checkout(b, "age-0002", age_confirmed=True)).status_code == 201
