"""Seller endpoints: merchant profile and documents, unit claims and transfers, storefront
customisation, products and stock, orders and revenue. Every route acts only on the caller's
own merchant."""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from app.api.deps import ClientIP, CurrentUser, SessionDep
from app.core.rate_limit import rate_limit
from app.marketplace import catalog, checkout, claims, merchants
from app.schemas.common import Message
from app.schemas.market import (
    ClaimIn,
    ClaimOut,
    DocumentOut,
    MerchantIn,
    MerchantOut,
    OrderOut,
    ProductIn,
    ProductOut,
    ProductPatch,
    RevenueOut,
    ShopIn,
    ShopOut,
    StockIn,
    TransferIn,
    TransferOut,
    TransitionIn,
)

router = APIRouter(prefix="/merchant", tags=["seller"])


@router.get("", response_model=MerchantOut)
async def get_merchant(user: CurrentUser, session: SessionDep) -> MerchantOut:
    merchant = await merchants.require_merchant(session, user)
    return await merchants.merchant_out(session, merchant, user)


@router.post(
    "",
    response_model=MerchantOut,
    status_code=201,
    dependencies=[Depends(rate_limit("merchant-apply", 5, 3600))],
)
async def apply(data: MerchantIn, user: CurrentUser, session: SessionDep, ip: ClientIP):
    merchant = await merchants.apply(session, user, data, ip)
    await session.refresh(user, ["roles"])
    return await merchants.merchant_out(session, merchant, user)


@router.put("", response_model=MerchantOut)
async def update(data: MerchantIn, user: CurrentUser, session: SessionDep) -> MerchantOut:
    merchant = await merchants.update(session, user, data)
    return await merchants.merchant_out(session, merchant, user)


@router.post(
    "/documents",
    response_model=DocumentOut,
    status_code=201,
    dependencies=[Depends(rate_limit("merchant-document", 20, 3600))],
)
async def upload_document(
    user: CurrentUser,
    session: SessionDep,
    ip: ClientIP,
    file: UploadFile = File(...),
    kind: Literal["business_registration", "id_document", "lease_or_utility", "other"] = Form(...),
) -> DocumentOut:
    doc = await merchants.add_document(session, user, kind, file, ip)
    return DocumentOut.model_validate(doc)


# ── claims ───────────────────────────────────────────────────────────────────────────


@router.get("/claims", response_model=list[ClaimOut])
async def my_claims(user: CurrentUser, session: SessionDep) -> list[ClaimOut]:
    return await claims.my_claims(session, user)


@router.post(
    "/claims",
    response_model=ClaimOut,
    status_code=201,
    dependencies=[Depends(rate_limit("claim", 20, 3600))],
)
async def claim(data: ClaimIn, user: CurrentUser, session: SessionDep, ip: ClientIP) -> ClaimOut:
    row = await claims.claim_unit(session, user, data, ip)
    return await claims.claim_out(session, row)


@router.post("/claims/{claim_id}/release", response_model=Message)
async def release(claim_id: uuid.UUID, user: CurrentUser, session: SessionDep, ip: ClientIP):
    await claims.release(session, user, claim_id, ip)
    return Message(message="Unit released")


@router.post("/claims/{claim_id}/renew", response_model=ClaimOut)
async def renew(claim_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> ClaimOut:
    row = await claims.renew(session, user, claim_id)
    return await claims.claim_out(session, row)


@router.post("/claims/{claim_id}/transfer", response_model=Message, status_code=201)
async def transfer(
    claim_id: uuid.UUID, data: TransferIn, user: CurrentUser, session: SessionDep, ip: ClientIP
) -> Message:
    await claims.offer_transfer(session, user, claim_id, data.to_username, ip)
    return Message(message="Transfer offered. The other merchant must accept it.")


@router.get("/transfers", response_model=list[TransferOut])
async def transfers(user: CurrentUser, session: SessionDep) -> list[TransferOut]:
    return await claims.my_transfers(session, user)


@router.post("/transfers/{transfer_id}/{action}", response_model=Message)
async def respond_transfer(
    transfer_id: uuid.UUID,
    action: Literal["accept", "decline", "cancel"],
    user: CurrentUser,
    session: SessionDep,
    ip: ClientIP,
) -> Message:
    await claims.respond_transfer(session, user, transfer_id, action == "accept", ip)
    return Message(
        message={"accept": "Transfer accepted", "decline": "Declined"}.get(action, "Cancelled")
    )


# ── storefronts ──────────────────────────────────────────────────────────────────────


@router.get("/shops", response_model=list[ShopOut])
async def my_shops(user: CurrentUser, session: SessionDep) -> list[ShopOut]:
    return await catalog.my_shops(session, user)


@router.patch("/shops/{shop_id}", response_model=ShopOut)
async def update_shop(
    shop_id: uuid.UUID, data: ShopIn, user: CurrentUser, session: SessionDep
) -> ShopOut:
    shop = await catalog.update_shop(session, user, shop_id, data)
    return await catalog.shop_out(session, shop)


# ── products ─────────────────────────────────────────────────────────────────────────


@router.get("/products", response_model=list[ProductOut])
async def products(user: CurrentUser, session: SessionDep) -> list[ProductOut]:
    return await catalog.my_products(session, user)


@router.post(
    "/products",
    response_model=ProductOut,
    status_code=201,
    dependencies=[Depends(rate_limit("product-create", 60, 3600))],
)
async def create_product(data: ProductIn, user: CurrentUser, session: SessionDep, ip: ClientIP):
    return catalog.product_out(await catalog.create_product(session, user, data, ip))


@router.patch("/products/{product_id}", response_model=ProductOut)
async def update_product(
    product_id: uuid.UUID, data: ProductPatch, user: CurrentUser, session: SessionDep, ip: ClientIP
) -> ProductOut:
    return catalog.product_out(await catalog.update_product(session, user, product_id, data, ip))


@router.put("/products/{product_id}/stock", response_model=ProductOut)
async def set_stock(
    product_id: uuid.UUID, data: StockIn, user: CurrentUser, session: SessionDep
) -> ProductOut:
    return catalog.product_out(await catalog.set_stock(session, user, product_id, data.on_hand))


@router.post(
    "/products/{product_id}/image",
    response_model=ProductOut,
    dependencies=[Depends(rate_limit("product-image", 60, 3600))],
)
async def set_image(
    product_id: uuid.UUID, user: CurrentUser, session: SessionDep, file: UploadFile = File(...)
) -> ProductOut:
    return catalog.product_out(await catalog.set_image(session, user, product_id, file))


@router.delete("/products/{product_id}", response_model=Message)
async def archive(product_id: uuid.UUID, user: CurrentUser, session: SessionDep, ip: ClientIP):
    await catalog.archive_product(session, user, product_id, ip)
    return Message(message="Product removed")


# ── orders and revenue ───────────────────────────────────────────────────────────────


@router.get("/orders", response_model=list[OrderOut])
async def orders(
    user: CurrentUser,
    session: SessionDep,
    status: str | None = Query(default=None, max_length=24),
) -> list[OrderOut]:
    merchant = await merchants.require_merchant(session, user)
    return await checkout.merchant_orders(session, merchant, status)


@router.post("/orders/{order_id}/transition", response_model=OrderOut)
async def transition(
    order_id: uuid.UUID, data: TransitionIn, user: CurrentUser, session: SessionDep, ip: ClientIP
) -> OrderOut:
    return await checkout.merchant_transition(session, user, order_id, data.to, data.reason, ip)


@router.get("/revenue", response_model=RevenueOut)
async def revenue(
    user: CurrentUser, session: SessionDep, days: int = Query(default=30, ge=1, le=365)
) -> RevenueOut:
    merchant = await merchants.require_merchant(session, user)
    return await checkout.revenue(session, merchant, days)
