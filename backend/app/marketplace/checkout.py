"""Cart, checkout, the demo payment, orders and their state machine, simulated refunds.

Money is integer US cents. The client never sends a price: the server reprices every line
from the database when showing the cart and again, under row locks, at checkout, where the
client's `expected_total_minor` must match or the checkout is refused (PRICE_CHANGED).

A checkout is one demo payment intent covering one order per merchant. It is idempotent per
(buyer, Idempotency-Key): replaying the same request returns the same intent and orders,
and a different request under the same key is refused. Confirming the payment locks the
intent row; a second confirmation returns the first result without side effects.

The demo payment moves no money and has no monetary value. There is no real provider.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from collections import defaultdict
from datetime import timedelta

from fastapi import status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, bad_request, conflict, not_found
from app.marketplace.catalog import image_url
from app.models import (
    Cart,
    CartItem,
    Inventory,
    Merchant,
    Order,
    OrderEvent,
    OrderItem,
    PaymentIntent,
    Product,
    Refund,
    RoleName,
    Shop,
    User,
)
from app.schemas.market import (
    CartAddIn,
    CartGroupOut,
    CartLineOut,
    CartOut,
    CheckoutIn,
    OrderEventOut,
    OrderItemOut,
    OrderOut,
    PaymentOut,
    RevenueDay,
    RevenueOut,
)
from app.services import audit
from app.utils.time import utcnow

MAX_LINES = 30
MAX_QUANTITY = 20
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9_\-]{8,64}$")

# Explicit order state machine (Part 8.3). Delivery states are driven by Phase 6.
TRANSITIONS: dict[str, set[str]] = {
    "draft": {"pending_payment", "cancelled"},
    "pending_payment": {"paid", "cancelled"},
    "paid": {"merchant_accepted", "refunded"},
    "merchant_accepted": {"preparing", "refunded"},
    "preparing": {"ready_for_pickup", "refunded"},
    "ready_for_pickup": {"completed", "assigned_to_driver", "refunded"},
    "assigned_to_driver": {"picked_up", "refunded"},
    "picked_up": {"in_transit"},
    "in_transit": {"delivered"},
    "delivered": {"completed"},
    "completed": set(),
    "cancelled": set(),
    "refunded": set(),
}
# Who may make which move. "system" moves happen only inside this module (payment, expiry).
ACTOR_MOVES: dict[str, set[tuple[str, str]]] = {
    "merchant": {
        ("paid", "merchant_accepted"),
        ("merchant_accepted", "preparing"),
        ("preparing", "ready_for_pickup"),
        ("ready_for_pickup", "completed"),
        ("paid", "refunded"),
        ("merchant_accepted", "refunded"),
        ("preparing", "refunded"),
        ("ready_for_pickup", "refunded"),
    },
    "buyer": {
        ("pending_payment", "cancelled"),
        ("paid", "refunded"),
        ("ready_for_pickup", "completed"),
    },
    "system": {("pending_payment", "paid"), ("pending_payment", "cancelled")},
    "admin": {(a, b) for a, targets in TRANSITIONS.items() for b in targets if b == "refunded"},
}
LIVE_ORDER = ("paid", "merchant_accepted", "preparing", "ready_for_pickup")
REVENUE_STATES = (
    *LIVE_ORDER,
    "assigned_to_driver",
    "picked_up",
    "in_transit",
    "delivered",
    "completed",
)


def require_buyer(user: User) -> None:
    if not user.has_role(RoleName.BUYER):
        raise AppError(
            status.HTTP_403_FORBIDDEN,
            "BUYER_ROLE_REQUIRED",
            "Shopping needs the buyer role (choose it in your profile's roles).",
        )


# ── cart ─────────────────────────────────────────────────────────────────────────────


async def _cart(session: AsyncSession, user: User, *, create: bool = False, lock: bool = False):
    # populate_existing: always re-read the cart and its lines (they change under us).
    stmt = select(Cart).where(Cart.user_id == user.id).execution_options(populate_existing=True)
    if lock:
        stmt = stmt.with_for_update()
    cart = await session.scalar(stmt)
    if cart is None and create:
        cart = Cart(user_id=user.id, items=[])  # an initialised (empty) collection
        session.add(cart)
        try:
            await session.flush()
        except IntegrityError:  # created concurrently
            await session.rollback()
            cart = await session.scalar(stmt)
    return cart


def _line_problem(product: Product, merchant: Merchant | None, quantity: int) -> str | None:
    if product.status != "active" or merchant is None or merchant.status != "approved":
        return "unavailable"
    stock = product.inventory.on_hand if product.inventory else 0
    if stock < quantity:
        return "insufficient_stock" if stock > 0 else "out_of_stock"
    return None


async def cart_out(session: AsyncSession, user: User) -> CartOut:
    cart = await _cart(session, user)
    items = list(cart.items) if cart else []
    merchants = (
        {
            m.id: m
            for m in (
                await session.scalars(
                    select(Merchant).where(Merchant.id.in_({i.merchant_id for i in items}))
                )
            ).all()
        }
        if items
        else {}
    )
    groups: dict[uuid.UUID, list[CartLineOut]] = defaultdict(list)
    for item in items:
        p = item.product
        merchant = merchants.get(item.merchant_id)
        problem = _line_problem(p, merchant, item.quantity)
        stock = p.inventory.on_hand if p.inventory else 0
        groups[item.merchant_id].append(
            CartLineOut(
                product_id=p.id,
                name=p.name,
                name_km=p.name_km,
                image_url=image_url(p.image_name),
                model=p.model,
                quantity=item.quantity,
                unit_price_minor=p.price_minor,
                quoted_price_minor=item.quoted_price_minor,
                price_changed=p.price_minor != item.quoted_price_minor,
                line_total_minor=p.price_minor * item.quantity,
                available=problem is None,
                problem=problem,
                stock=stock,
                min_age=p.category.min_age,
                shop_id=item.shop_id,
            )
        )
    out_groups = [
        CartGroupOut(
            merchant_id=mid,
            merchant_name=merchants[mid].business_name if mid in merchants else "?",
            lines=lines,
            subtotal_minor=sum(line.line_total_minor for line in lines if line.available),
        )
        for mid, lines in groups.items()
    ]
    lines = [line for g in out_groups for line in g.lines]
    return CartOut(
        groups=out_groups,
        item_count=sum(line.quantity for line in lines),
        total_minor=sum(g.subtotal_minor for g in out_groups),
        needs_age_confirmation=any(line.min_age for line in lines),
        can_checkout=bool(lines) and all(line.available for line in lines),
    )


async def add_item(session: AsyncSession, user: User, data: CartAddIn) -> CartOut:
    require_buyer(user)
    product = await session.get(Product, data.product_id)
    if product is None or product.status == "archived":
        raise not_found("Product")
    merchant = await session.get(Merchant, product.merchant_id)
    if merchant is not None and merchant.owner_id == user.id:
        raise bad_request("OWN_PRODUCT", "You cannot buy from your own shop.")
    cart = await _cart(session, user, create=True, lock=True)
    existing = next((i for i in cart.items if i.product_id == product.id), None)
    quantity = data.quantity + (existing.quantity if existing else 0)
    if quantity > MAX_QUANTITY:
        raise conflict("QUANTITY_LIMIT", f"Up to {MAX_QUANTITY} of one product per order.")
    problem = _line_problem(product, merchant, quantity)
    if problem:
        raise conflict(
            "UNAVAILABLE" if problem == "unavailable" else "INSUFFICIENT_STOCK",
            "This product is not available."
            if problem == "unavailable"
            else f"Only {product.inventory.on_hand if product.inventory else 0} left in stock.",
        )
    shop_id = None
    if data.shop_id:
        shop = await session.get(Shop, data.shop_id)
        if shop is not None and shop.merchant_id == product.merchant_id and shop.status == "active":
            shop_id = shop.id
    if existing:
        existing.quantity = quantity
        existing.quoted_price_minor = product.price_minor
        existing.shop_id = shop_id or existing.shop_id
    else:
        if len(cart.items) >= MAX_LINES:
            raise conflict("CART_FULL", f"Up to {MAX_LINES} different products in a cart.")
        cart.items.append(
            CartItem(
                product_id=product.id,
                merchant_id=product.merchant_id,
                shop_id=shop_id,
                quantity=quantity,
                quoted_price_minor=product.price_minor,
            )
        )
    await session.commit()
    return await cart_out(session, user)


async def set_quantity(
    session: AsyncSession, user: User, product_id: uuid.UUID, quantity: int
) -> CartOut:
    cart = await _cart(session, user, lock=True)
    item = next((i for i in cart.items if i.product_id == product_id), None) if cart else None
    if item is None:
        raise not_found("Cart item")
    stock = item.product.inventory.on_hand if item.product.inventory else 0
    if quantity > stock:
        raise conflict("INSUFFICIENT_STOCK", f"Only {stock} left in stock.")
    item.quantity = quantity
    item.quoted_price_minor = item.product.price_minor
    await session.commit()
    return await cart_out(session, user)


async def remove_item(session: AsyncSession, user: User, product_id: uuid.UUID | None) -> CartOut:
    cart = await _cart(session, user, lock=True)
    if cart is not None:
        stmt = delete(CartItem).where(CartItem.cart_id == cart.id)
        if product_id is not None:
            stmt = stmt.where(CartItem.product_id == product_id)
        await session.execute(stmt)
        await session.commit()
    return await cart_out(session, user)


# ── checkout ─────────────────────────────────────────────────────────────────────────


def _request_hash(data: CheckoutIn) -> str:
    """Fingerprint of the checkout request body. A retry with the same Idempotency-Key must
    send the same body (the cart is consumed by the first attempt, so it is not included)."""
    body = data.model_dump(mode="json")
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


async def _intent_for_key(session: AsyncSession, user: User, key: str) -> PaymentIntent | None:
    return await session.scalar(
        select(PaymentIntent).where(
            PaymentIntent.buyer_id == user.id, PaymentIntent.idempotency_key == key
        )
    )


async def _replay(
    session: AsyncSession, user: User, key: str, data: CheckoutIn
) -> PaymentOut | None:
    intent = await _intent_for_key(session, user, key)
    if intent is None:
        return None
    if intent.request_hash != _request_hash(data):
        raise conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was used for a different checkout request.",
        )
    return await payment_out(session, intent, user)


async def checkout(
    session: AsyncSession, user: User, data: CheckoutIn, key: str | None, ip: str
) -> PaymentOut:
    require_buyer(user)
    if not key or not IDEMPOTENCY_KEY.fullmatch(key):
        raise bad_request(
            "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (8–64 letters/digits)."
        )
    if not settings.demo_payments_enabled:
        raise AppError(status.HTTP_403_FORBIDDEN, "PAYMENTS_DISABLED", "Checkout is disabled.")
    replay = await _replay(session, user, key, data)
    if replay is not None:
        return replay  # same key and body: the same checkout, no new orders

    cart = await _cart(session, user, lock=True)  # one checkout at a time per buyer
    replay = await _replay(session, user, key, data)  # a concurrent twin may have won
    if replay is not None:
        return replay
    items = list(cart.items) if cart else []
    if not items:
        raise conflict("CART_EMPTY", "Your cart is empty.")

    # Lock stock rows in a fixed order (no deadlocks between concurrent checkouts).
    product_ids = sorted({i.product_id for i in items})
    inventory = {
        inv.product_id: inv
        for inv in (
            await session.scalars(
                select(Inventory)
                .where(Inventory.product_id.in_(product_ids))
                .order_by(Inventory.product_id)
                .with_for_update()
            )
        ).all()
    }
    products = {
        p.id: p
        for p in (
            await session.scalars(
                select(Product)
                .where(Product.id.in_(product_ids))
                .execution_options(populate_existing=True)
            )
        )
        .unique()
        .all()
    }
    merchants = {
        m.id: m
        for m in (
            await session.scalars(
                select(Merchant).where(Merchant.id.in_({p.merchant_id for p in products.values()}))
            )
        ).all()
    }
    problems = []
    for item in items:
        product = products.get(item.product_id)
        stock = inventory[item.product_id].on_hand if item.product_id in inventory else 0
        merchant = merchants.get(product.merchant_id) if product else None
        if (
            product is None
            or product.status != "active"
            or not merchant
            or merchant.status != "approved"
        ):
            problems.append({"product_id": str(item.product_id), "reason": "unavailable"})
        elif stock < item.quantity:
            problems.append(
                {
                    "product_id": str(item.product_id),
                    "reason": "insufficient_stock",
                    "available": stock,
                }
            )
    if problems:
        raise conflict("ITEMS_UNAVAILABLE", "Some items are no longer available.", problems)
    if any(products[i.product_id].category.min_age for i in items) and not data.age_confirmed:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "AGE_CONFIRMATION_REQUIRED",
            "Your cart has age-restricted items: confirm you are 18 or older.",
        )

    by_merchant: dict[uuid.UUID, list[CartItem]] = defaultdict(list)
    for item in items:
        by_merchant[products[item.product_id].merchant_id].append(item)
    total = sum(products[i.product_id].price_minor * i.quantity for i in items)
    if total != data.expected_total_minor:
        raise conflict(
            "PRICE_CHANGED",
            "Prices changed since you looked at your cart. Please review the new total.",
            {"expected_total_minor": data.expected_total_minor, "actual_total_minor": total},
        )

    intent = PaymentIntent(
        buyer_id=user.id,
        idempotency_key=key,
        request_hash=_request_hash(data),
        amount_minor=total,
        status="requires_confirmation",
        expires_at=utcnow() + timedelta(minutes=settings.payment_expiry_minutes),
    )
    session.add(intent)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("IDEMPOTENCY_CONFLICT", "This checkout is already being processed.") from exc
    for merchant_id, lines in by_merchant.items():
        subtotal = sum(products[i.product_id].price_minor * i.quantity for i in lines)
        pickup = next((i.shop_id for i in lines if i.shop_id), None) or await session.scalar(
            select(Shop.id)
            .where(Shop.merchant_id == merchant_id, Shop.status == "active")
            .order_by(Shop.created_at)
            .limit(1)
        )
        order = Order(
            buyer_id=user.id,
            merchant_id=merchant_id,
            pickup_shop_id=pickup,
            payment_intent_id=intent.id,
            status="pending_payment",
            fulfillment=data.fulfillment,
            subtotal_minor=subtotal,
            delivery_fee_minor=0,
            total_minor=subtotal,
            note=data.note,
        )
        for line in lines:
            product = products[line.product_id]
            order.items.append(
                OrderItem(
                    product_id=product.id,
                    name=product.name,
                    name_km=product.name_km,
                    unit_price_minor=product.price_minor,
                    quantity=line.quantity,
                    line_total_minor=product.price_minor * line.quantity,
                )
            )
            inventory[line.product_id].on_hand -= line.quantity  # reserved for this order
        order.events.append(
            OrderEvent(
                from_status=None, to_status="pending_payment", actor_id=user.id, actor_role="buyer"
            )
        )
        session.add(order)
    await session.execute(delete(CartItem).where(CartItem.cart_id == cart.id))
    audit.record(
        session,
        "checkout.created",
        actor=user.id,
        target_type="payment_intent",
        target_id=intent.id,
        ip=ip,
        amount_minor=total,
        orders=len(by_merchant),
    )
    await session.commit()
    return await payment_out(session, await _reload_intent(session, intent.id), user)


async def _reload_intent(session: AsyncSession, intent_id: uuid.UUID) -> PaymentIntent:
    intent = await session.scalar(
        select(PaymentIntent)
        .where(PaymentIntent.id == intent_id)
        .execution_options(populate_existing=True)
    )
    assert intent is not None
    return intent


async def _restore_stock(session: AsyncSession, order: Order) -> None:
    ids = sorted({i.product_id for i in order.items if i.product_id})
    if not ids:
        return
    inventory = {
        inv.product_id: inv
        for inv in (
            await session.scalars(
                select(Inventory)
                .where(Inventory.product_id.in_(ids))
                .order_by(Inventory.product_id)
                .with_for_update()
            )
        ).all()
    }
    for item in order.items:
        if item.product_id in inventory:
            inventory[item.product_id].on_hand += item.quantity


async def _move(
    session: AsyncSession,
    order: Order,
    to: str,
    *,
    actor: uuid.UUID | None,
    role: str,
    note: str | None = None,
) -> None:
    """Apply one allowed transition with its side effects and history entry."""
    current = order.status
    if to not in TRANSITIONS[current] or (current, to) not in ACTOR_MOVES[role]:
        allowed = sorted(b for a, b in ACTOR_MOVES[role] if a == current)
        raise AppError(
            status.HTTP_409_CONFLICT,
            "INVALID_TRANSITION",
            f"Cannot change an order from {current} to {to}.",
            {"from": current, "to": to, "allowed": allowed},
        )
    if to in ("cancelled", "refunded"):
        await _restore_stock(session, order)
        order.cancel_reason = (note or ("Refunded" if to == "refunded" else "Cancelled"))[:300]
    if to == "refunded":
        session.add(
            Refund(
                order_id=order.id,
                payment_intent_id=order.payment_intent_id,
                amount_minor=order.total_minor,
                reason=order.cancel_reason or "Refunded",
                actor_id=actor,
            )
        )
    if to == "paid":
        order.paid_at = utcnow()
    if to == "completed":
        order.completed_at = utcnow()
    order.status = to
    order.events.append(
        OrderEvent(from_status=current, to_status=to, actor_id=actor, actor_role=role, note=note)
    )


# ── payment ──────────────────────────────────────────────────────────────────────────


async def _own_intent(
    session: AsyncSession, user: User, intent_id: uuid.UUID, *, lock: bool = False
) -> PaymentIntent:
    stmt = select(PaymentIntent).where(PaymentIntent.id == intent_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    intent = await session.scalar(stmt)
    if intent is None or intent.buyer_id != user.id:  # same answer for "not yours"
        raise not_found("Payment")
    return intent


async def _locked_orders(session: AsyncSession, intent: PaymentIntent) -> list[Order]:
    return list(
        (
            await session.scalars(
                select(Order)
                .where(Order.payment_intent_id == intent.id)
                .order_by(Order.id)
                .with_for_update(of=Order)
                .execution_options(populate_existing=True)
            )
        )
        .unique()
        .all()
    )


async def _close_intent(
    session: AsyncSession,
    intent: PaymentIntent,
    new_status: str,
    actor: uuid.UUID | None,
    role: str,
) -> None:
    """Cancel or expire an unpaid checkout: its orders are cancelled and stock released."""
    intent.status = new_status
    for order in await _locked_orders(session, intent):
        if order.status == "pending_payment":
            await _move(
                session,
                order,
                "cancelled",
                actor=actor,
                role=role,
                note="Payment window expired" if new_status == "expired" else "Checkout cancelled",
            )


async def confirm_payment(
    session: AsyncSession, user: User, intent_id: uuid.UUID, ip: str
) -> PaymentOut:
    if not settings.demo_payments_enabled:
        raise AppError(
            status.HTTP_403_FORBIDDEN, "PAYMENTS_DISABLED", "Demo payments are disabled."
        )
    intent = await _own_intent(session, user, intent_id, lock=True)  # serialises confirmations
    if intent.status == "succeeded":
        return await payment_out(session, intent, user, already=True)
    if intent.status != "requires_confirmation":
        raise conflict("PAYMENT_NOT_PAYABLE", f"This payment is {intent.status}.")
    if intent.expires_at <= utcnow():
        await _close_intent(session, intent, "expired", None, "system")
        await session.commit()
        raise conflict("PAYMENT_EXPIRED", "This checkout expired. Your items were released.")
    orders = await _locked_orders(session, intent)
    if sum(o.total_minor for o in orders) != intent.amount_minor:
        raise conflict("AMOUNT_MISMATCH", "The payment does not match the orders.")
    intent.status = "succeeded"
    intent.succeeded_at = utcnow()
    intent.reference = "DEMO-" + secrets.token_hex(6).upper()
    for order in orders:
        await _move(session, order, "paid", actor=user.id, role="system", note="Demo payment")
    audit.record(
        session,
        "payment.succeeded",
        actor=user.id,
        target_type="payment_intent",
        target_id=intent.id,
        ip=ip,
        amount_minor=intent.amount_minor,
        demo=True,
    )
    await session.commit()
    _notify_merchants(session, orders)
    return await payment_out(session, await _reload_intent(session, intent.id), user)


def _notify_merchants(session: AsyncSession, orders: list[Order]) -> None:
    from app.multiplayer.hub import hub

    for order in orders:
        owner = order.merchant.owner_id if order.merchant else None
        if owner:
            hub.notify_user(owner, {"t": "order", "number": order.number, "status": order.status})


async def cancel_payment(session: AsyncSession, user: User, intent_id: uuid.UUID) -> PaymentOut:
    intent = await _own_intent(session, user, intent_id, lock=True)
    if intent.status != "requires_confirmation":
        raise conflict("PAYMENT_NOT_PENDING", f"This payment is {intent.status}.")
    await _close_intent(session, intent, "cancelled", user.id, "buyer")
    await session.commit()
    return await payment_out(session, await _reload_intent(session, intent.id), user)


async def get_payment(session: AsyncSession, user: User, intent_id: uuid.UUID) -> PaymentOut:
    intent = await _own_intent(session, user, intent_id)
    if intent.status == "requires_confirmation" and intent.expires_at <= utcnow():
        intent = await _own_intent(session, user, intent_id, lock=True)
        if intent.status == "requires_confirmation":
            await _close_intent(session, intent, "expired", None, "system")
            await session.commit()
        intent = await _reload_intent(session, intent_id)
    return await payment_out(session, intent, user)


async def expire_due_payments(session: AsyncSession) -> int:
    due = (
        await session.scalars(
            select(PaymentIntent)
            .where(
                PaymentIntent.status == "requires_confirmation",
                PaymentIntent.expires_at <= utcnow(),
            )
            .with_for_update(skip_locked=True)
            .limit(200)
        )
    ).all()
    for intent in due:
        await _close_intent(session, intent, "expired", None, "system")
    if due:
        await session.commit()
    return len(due)


# ── orders ───────────────────────────────────────────────────────────────────────────


async def payment_out(
    session: AsyncSession, intent: PaymentIntent, user: User, *, already: bool = False
) -> PaymentOut:
    orders = (
        (
            await session.scalars(
                select(Order)
                .where(Order.payment_intent_id == intent.id)
                .order_by(Order.created_at, Order.id)
                .execution_options(populate_existing=True)
            )
        )
        .unique()
        .all()
    )
    return PaymentOut(
        id=intent.id,
        status=intent.status,
        amount_minor=intent.amount_minor,
        currency=intent.currency,
        provider=intent.provider,
        reference=intent.reference,
        expires_at=intent.expires_at,
        succeeded_at=intent.succeeded_at,
        orders=[await order_out(session, o, "buyer", intent) for o in orders],
        already_confirmed=already,
    )


async def order_out(
    session: AsyncSession, order: Order, viewer: str, intent: PaymentIntent | None = None
) -> OrderOut:
    intent = intent or await session.get(PaymentIntent, order.payment_intent_id)
    shop = await session.get(Shop, order.pickup_shop_id) if order.pickup_shop_id else None
    buyer = (
        await session.scalar(select(User.username).where(User.id == order.buyer_id))
        if viewer in ("merchant", "admin") and order.buyer_id
        else None
    )
    refunded = await session.scalar(
        select(func.coalesce(func.sum(Refund.amount_minor), 0)).where(Refund.order_id == order.id)
    )
    return OrderOut(
        id=order.id,
        number=order.number,
        status=order.status,
        fulfillment=order.fulfillment,
        merchant_id=order.merchant_id,
        merchant_name=order.merchant.business_name if order.merchant else "?",
        buyer_username=buyer,
        pickup_shop=shop.name if shop else None,
        pickup_unit=shop.unit.code if shop else None,
        subtotal_minor=order.subtotal_minor,
        delivery_fee_minor=order.delivery_fee_minor,
        total_minor=order.total_minor,
        currency=order.currency,
        note=order.note,
        cancel_reason=order.cancel_reason,
        payment_intent_id=order.payment_intent_id,
        payment_status=intent.status if intent else "?",
        created_at=order.created_at,
        paid_at=order.paid_at,
        completed_at=order.completed_at,
        items=[OrderItemOut.model_validate(i) for i in order.items],
        events=[OrderEventOut.model_validate(e) for e in order.events],
        refunded_minor=int(refunded or 0),
        allowed=sorted(b for a, b in ACTOR_MOVES.get(viewer, set()) if a == order.status),
    )


async def buyer_orders(session: AsyncSession, user: User) -> list[OrderOut]:
    orders = (
        (
            await session.scalars(
                select(Order)
                .where(Order.buyer_id == user.id)
                .order_by(Order.created_at.desc())
                .limit(50)
            )
        )
        .unique()
        .all()
    )
    return [await order_out(session, o, "buyer") for o in orders]


async def _order_for(
    session: AsyncSession, user: User, order_id: uuid.UUID, *, lock: bool = False
) -> tuple[Order, str]:
    stmt = select(Order).where(Order.id == order_id)
    if lock:
        stmt = stmt.with_for_update(of=Order).execution_options(populate_existing=True)
    order = await session.scalar(stmt)
    if order is not None:
        if order.buyer_id == user.id:
            return order, "buyer"
        if order.merchant and order.merchant.owner_id == user.id:
            return order, "merchant"
        if user.has_role(RoleName.ADMIN):
            return order, "admin"
    raise not_found("Order")  # never reveal that someone else's order exists


async def get_order(session: AsyncSession, user: User, order_id: uuid.UUID) -> OrderOut:
    order, role = await _order_for(session, user, order_id)
    return await order_out(session, order, role)


async def buyer_cancel(
    session: AsyncSession, user: User, order_id: uuid.UUID, reason: str | None
) -> OrderOut:
    order, role = await _order_for(session, user, order_id, lock=True)
    if role != "buyer":
        raise not_found("Order")
    if order.status == "pending_payment":
        intent = await _own_intent(session, user, order.payment_intent_id, lock=True)
        await _close_intent(session, intent, "cancelled", user.id, "buyer")
    else:
        await _move(
            session,
            order,
            "refunded",
            actor=user.id,
            role="buyer",
            note=reason or "Cancelled by buyer",
        )
    await session.commit()
    return await get_order(session, user, order_id)


async def buyer_received(session: AsyncSession, user: User, order_id: uuid.UUID) -> OrderOut:
    order, role = await _order_for(session, user, order_id, lock=True)
    if role != "buyer":
        raise not_found("Order")
    await _move(session, order, "completed", actor=user.id, role="buyer", note="Collected")
    await session.commit()
    return await get_order(session, user, order_id)


async def merchant_orders(
    session: AsyncSession, merchant: Merchant, status_filter: str | None
) -> list[OrderOut]:
    stmt = select(Order).where(Order.merchant_id == merchant.id)
    if status_filter == "open":
        stmt = stmt.where(Order.status.in_(LIVE_ORDER))
    elif status_filter:
        stmt = stmt.where(Order.status == status_filter)
    else:
        stmt = stmt.where(Order.status != "pending_payment")
    orders = (
        (await session.scalars(stmt.order_by(Order.created_at.desc()).limit(100))).unique().all()
    )
    return [await order_out(session, o, "merchant") for o in orders]


async def merchant_transition(
    session: AsyncSession, user: User, order_id: uuid.UUID, to: str, reason: str | None, ip: str
) -> OrderOut:
    order, role = await _order_for(session, user, order_id, lock=True)
    if role not in ("merchant", "admin"):
        raise not_found("Order")
    await _move(session, order, to, actor=user.id, role=role, note=reason)
    if to == "refunded":
        audit.record(
            session,
            "order.refunded",
            actor=user.id,
            target_type="order",
            target_id=order.id,
            ip=ip,
            amount_minor=order.total_minor,
            by=role,
        )
    await session.commit()
    if order.buyer_id:
        from app.multiplayer.hub import hub

        hub.notify_user(order.buyer_id, {"t": "order", "number": order.number, "status": to})
    return await order_out(session, order, role)


async def revenue(session: AsyncSession, merchant: Merchant, days: int) -> RevenueOut:
    since = utcnow() - timedelta(days=days)
    day = func.to_char(func.timezone(settings.timezone, Order.paid_at), "YYYY-MM-DD")
    rows = (
        await session.execute(
            select(day, func.count(Order.id), func.sum(Order.total_minor))
            .where(
                Order.merchant_id == merchant.id,
                Order.status.in_(REVENUE_STATES),
                Order.paid_at >= since,
            )
            .group_by(day)
            .order_by(day)
        )
    ).all()
    refunded = await session.scalar(
        select(func.coalesce(func.sum(Refund.amount_minor), 0))
        .join(Order, Order.id == Refund.order_id)
        .where(Order.merchant_id == merchant.id, Refund.created_at >= since)
    )
    open_orders = await session.scalar(
        select(func.count())
        .select_from(Order)
        .where(Order.merchant_id == merchant.id, Order.status.in_(LIVE_ORDER))
    )
    out_days = [RevenueDay(day=d, orders=n, revenue_minor=int(s or 0)) for d, n, s in rows]
    return RevenueOut(
        days=out_days,
        total_orders=sum(d.orders for d in out_days),
        total_revenue_minor=sum(d.revenue_minor for d in out_days),
        refunded_minor=int(refunded or 0),
        open_orders=int(open_orders or 0),
    )
