"""Buyer endpoints: cart, checkout (Idempotency-Key), the demo payment, and orders."""

import uuid

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from app.api.deps import ClientIP, CurrentUser, SessionDep
from app.core.rate_limit import rate_limit
from app.marketplace import checkout
from app.schemas.market import (
    CartAddIn,
    CartOut,
    CartQuantityIn,
    CheckoutIn,
    OrderOut,
    PaymentOut,
)

router = APIRouter(tags=["shopping"])


class ReasonIn(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


@router.get("/cart", response_model=CartOut)
async def cart(user: CurrentUser, session: SessionDep) -> CartOut:
    return await checkout.cart_out(session, user)


@router.post(
    "/cart/items", response_model=CartOut, dependencies=[Depends(rate_limit("cart", 120, 60))]
)
async def add(data: CartAddIn, user: CurrentUser, session: SessionDep) -> CartOut:
    return await checkout.add_item(session, user, data)


@router.patch("/cart/items/{product_id}", response_model=CartOut)
async def quantity(
    product_id: uuid.UUID, data: CartQuantityIn, user: CurrentUser, session: SessionDep
) -> CartOut:
    return await checkout.set_quantity(session, user, product_id, data.quantity)


@router.delete("/cart/items/{product_id}", response_model=CartOut)
async def remove(product_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> CartOut:
    return await checkout.remove_item(session, user, product_id)


@router.delete("/cart", response_model=CartOut)
async def clear(user: CurrentUser, session: SessionDep) -> CartOut:
    return await checkout.remove_item(session, user, None)


@router.post(
    "/checkout",
    response_model=PaymentOut,
    status_code=201,
    dependencies=[Depends(rate_limit("checkout", 20, 600))],
)
async def create_checkout(
    data: CheckoutIn,
    user: CurrentUser,
    session: SessionDep,
    ip: ClientIP,
    idempotency_key: str | None = Header(default=None, max_length=64),
) -> PaymentOut:
    return await checkout.checkout(session, user, data, idempotency_key, ip)


@router.get("/payments/{intent_id}", response_model=PaymentOut)
async def payment(intent_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> PaymentOut:
    return await checkout.get_payment(session, user, intent_id)


@router.post(
    "/payments/{intent_id}/confirm",
    response_model=PaymentOut,
    dependencies=[Depends(rate_limit("pay", 30, 600))],
)
async def confirm(
    intent_id: uuid.UUID, user: CurrentUser, session: SessionDep, ip: ClientIP
) -> PaymentOut:
    """Demo payment: no money moves. Repeating it returns the first result."""
    return await checkout.confirm_payment(session, user, intent_id, ip)


@router.post("/payments/{intent_id}/cancel", response_model=PaymentOut)
async def cancel_payment(intent_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    return await checkout.cancel_payment(session, user, intent_id)


@router.get("/orders", response_model=list[OrderOut])
async def orders(user: CurrentUser, session: SessionDep) -> list[OrderOut]:
    return await checkout.buyer_orders(session, user)


@router.get("/orders/{order_id}", response_model=OrderOut)
async def order(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> OrderOut:
    return await checkout.get_order(session, user, order_id)


@router.post("/orders/{order_id}/cancel", response_model=OrderOut)
async def cancel_order(
    order_id: uuid.UUID, data: ReasonIn, user: CurrentUser, session: SessionDep
) -> OrderOut:
    return await checkout.buyer_cancel(session, user, order_id, data.reason)


@router.post("/orders/{order_id}/received", response_model=OrderOut)
async def received(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> OrderOut:
    return await checkout.buyer_received(session, user, order_id)
