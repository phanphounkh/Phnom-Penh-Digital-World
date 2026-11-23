"""Buying in person: paying at a walk-in shop's counter for the basket (the cart lines from that
shop) completes the sale at once, only for a player standing in the shop, in one transaction."""

import uuid

from app.multiplayer.hub import hub
from tests.conftest import expect, onboard, shop_with_products, world_socket
from tests.test_market_shopping import BOOK, COFFEE, NOODLES, stock_of


def stand(user_id: uuid.UUID, shop_id: str, inside: bool) -> None:
    """Put the player (in the world) on the shop's floor, or out on a far street."""
    player = hub.by_user[user_id]
    point = player.room.shop_floors[shop_id].representative_point()
    player.x, player.z = (point.x, point.y) if inside else (point.x + 300, point.y)


async def pay(c, shop_id: str, total: int, key: str, **body):
    return await c.post(
        f"/shops/{shop_id}/counter",
        json={"expected_total_minor": total, **body},
        headers={"Idempotency-Key": key},
    )


async def test_paying_at_the_counter_hands_the_basket_over_at_once(clients, admin_client):
    seller, shop, (noodles, coffee) = await shop_with_products(
        clients, admin_client, "seller_sa", [NOODLES, COFFEE]
    )
    _other, other_shop, (book,) = await shop_with_products(
        clients, admin_client, "seller_ot", [BOOK]
    )
    buyer = await clients()
    me = await onboard(buyer, "buyer_counter", roles=["buyer"])
    uid = uuid.UUID(me["id"])
    for product, quantity, at in ((noodles, 2, shop), (coffee, 1, shop), (book, 1, other_shop)):
        r = await buyer.post(
            "/cart/items",
            json={"product_id": product["id"], "quantity": quantity, "shop_id": at["id"]},
        )
        assert r.status_code == 200, r.text
    basket = 2 * 250 + 150

    # Not in the city: no.
    r = await pay(buyer, shop["id"], basket, "counter-key-0001")
    assert r.status_code == 403 and r.json()["error"]["code"] == "AT_THE_COUNTER"
    async with world_socket(seller) as seller_ws, world_socket(buyer) as ws:
        await expect(seller_ws, "welcome")
        await expect(ws, "welcome")
        stand(uid, shop["id"], inside=False)
        r = await pay(buyer, shop["id"], basket, "counter-key-0001")
        assert r.status_code == 403 and r.json()["error"]["code"] == "AT_THE_COUNTER"

        stand(uid, shop["id"], inside=True)
        # The price the buyer saw must still hold.
        r = await pay(buyer, shop["id"], basket - 1, "counter-key-0002")
        assert r.status_code == 409 and r.json()["error"]["code"] == "PRICE_CHANGED"

        r = await pay(buyer, shop["id"], basket, "counter-key-0003")
        assert r.status_code == 201, r.text
        receipt = r.json()
        assert receipt["status"] == "succeeded" and receipt["amount_minor"] == basket
        assert receipt["reference"].startswith("DEMO-")
        (order,) = receipt["orders"]
        assert order["status"] == "completed" and order["in_person"] is True
        assert order["fulfillment"] == "pickup" and order["pickup_shop"] == shop["name"]
        assert sorted((i["name"], i["quantity"]) for i in order["items"]) == [
            ("Iced coffee", 1),
            ("Kuy teav", 2),
        ]
        assert [e["to_status"] for e in order["events"]] == ["pending_payment", "paid", "completed"]
        # The seller hears of the sale; there is nothing for them to do.
        sold = await expect(seller_ws, "order")
        assert sold["sold"] is True and sold["status"] == "completed"
        assert sold["number"] == order["number"] and sold["total"] == basket
        await expect(ws, "shops")  # players around reload the shelves (the stock changed)

        # A retry of the same request gets the same receipt, not a second sale.
        again = await pay(buyer, shop["id"], basket, "counter-key-0003")
        assert again.status_code == 201 and again.json()["id"] == receipt["id"]

    # Stock is gone from the shelf, the other shop's line waits in the cart, money moved.
    assert await stock_of(noodles["id"]) == 8 and await stock_of(coffee["id"]) == 9
    cart = (await buyer.get("/cart")).json()
    assert [line["name"] for g in cart["groups"] for line in g["lines"]] == ["Khmer phrasebook"]
    assert (await buyer.get("/wallet")).json()["balance_minor"] == 10_000 - basket
    assert (await seller.get("/wallet")).json()["balance_minor"] == 10_000 + basket
    mine = (await seller.get("/merchant/orders")).json()
    assert [(o["number"], o["status"], o["in_person"]) for o in mine] == [
        (order["number"], "completed", True)
    ]
    assert (await seller.get("/merchant/revenue")).json()["total_revenue_minor"] == basket
    assert (await buyer.get("/orders")).json()[0]["in_person"] is True


async def test_a_failed_counter_payment_changes_nothing(clients, admin_client):
    seller, shop, (silk,) = await shop_with_products(
        clients,
        admin_client,
        "seller_si",
        [{"name": "Wedding banquet", "price_minor": 6000, "model": "rice"}],
    )
    buyer = await clients()
    me = await onboard(buyer, "buyer_poor", roles=["buyer"])
    uid = uuid.UUID(me["id"])
    async with world_socket(buyer) as ws:
        await expect(ws, "welcome")
        stand(uid, shop["id"], inside=True)
        # Nothing in the basket from this shop.
        r = await pay(buyer, shop["id"], 100, "counter-key-0010")
        assert r.status_code == 409 and r.json()["error"]["code"] == "BASKET_EMPTY"

        await buyer.post(
            "/cart/items", json={"product_id": silk["id"], "quantity": 2, "shop_id": shop["id"]}
        )
        # $120 with $100 of demo credits: refused, and the basket, stock and wallet are as before.
        r = await pay(buyer, shop["id"], 12_000, "counter-key-0011")
        assert r.status_code == 409 and r.json()["error"]["code"] == "INSUFFICIENT_FUNDS"
        assert await stock_of(silk["id"]) == 10
        cart = (await buyer.get("/cart")).json()
        assert cart["item_count"] == 2 and cart["total_minor"] == 12_000
        assert (await buyer.get("/wallet")).json()["balance_minor"] == 10_000
        assert (await buyer.get("/orders")).json() == []

        # A closed shop does not sell.
        r = await seller.patch(f"/merchant/shops/{shop['id']}", json={"is_open": False})
        assert r.status_code == 200, r.text
        r = await pay(buyer, shop["id"], 12_000, "counter-key-0012")
        assert r.status_code == 409 and r.json()["error"]["code"] == "SHOP_CLOSED"
