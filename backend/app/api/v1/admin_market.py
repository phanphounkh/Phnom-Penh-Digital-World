"""Administrator review for the marketplace: merchants and their documents, unit claims,
disputes, and restricted-category products. Every decision is audited."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from app.api.deps import AdminUser, ClientIP, SessionDep
from app.core.errors import not_found
from app.marketplace import catalog, claims, media, merchants
from app.schemas.common import Message
from app.schemas.market import (
    AdminMerchantOut,
    AdminProductOut,
    ClaimOut,
    Decision,
    DisputeOut,
    DisputeResolution,
)
from app.services import audit

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/merchants", response_model=list[AdminMerchantOut])
async def list_merchants(
    _: AdminUser,
    session: SessionDep,
    status: Literal["pending", "approved", "rejected", "suspended"] | None = "pending",
) -> list[AdminMerchantOut]:
    return await merchants.admin_list(session, status)


@router.post("/merchants/{merchant_id}/{action}", response_model=Message)
async def decide_merchant(
    merchant_id: uuid.UUID,
    action: Literal["approve", "reject", "suspend"],
    data: Decision,
    admin: AdminUser,
    session: SessionDep,
    ip: ClientIP,
) -> Message:
    merchant = await merchants.decide(session, admin, merchant_id, action, data.reason, ip)
    if action == "suspend":
        from app.multiplayer.hub import hub

        await hub.shops_changed()
    return Message(message=f"Merchant {merchant.status}")


@router.get("/documents/{document_id}")
async def document(
    document_id: uuid.UUID, admin: AdminUser, session: SessionDep, ip: ClientIP
) -> FileResponse:
    doc = await merchants.document_for_admin(session, document_id)
    path = media.document_path(doc.stored_name)
    if path is None:
        raise not_found("Document file")
    audit.record(
        session, "document.viewed", actor=admin.id, target_type="document", target_id=doc.id, ip=ip
    )
    await session.commit()
    return FileResponse(
        path,
        media_type=doc.content_type,
        filename=doc.original_name,
        content_disposition_type="attachment",
        headers={"Cache-Control": "no-store", "Content-Security-Policy": "sandbox"},
    )


@router.get("/claims", response_model=list[ClaimOut])
async def list_claims(
    _: AdminUser,
    session: SessionDep,
    status: Literal["pending", "approved", "rejected", "released", "expired", "revoked"] = Query(
        default="pending"
    ),
) -> list[ClaimOut]:
    return await claims.admin_claims(session, status)


@router.post("/claims/{claim_id}/{action}", response_model=Message)
async def decide_claim(
    claim_id: uuid.UUID,
    action: Literal["approve", "reject", "revoke"],
    data: Decision,
    admin: AdminUser,
    session: SessionDep,
    ip: ClientIP,
) -> Message:
    claim = await claims.admin_decide(session, admin, claim_id, action, data.reason, ip)
    return Message(message=f"Claim {claim.status}")


@router.get("/disputes", response_model=list[DisputeOut])
async def list_disputes(
    _: AdminUser,
    session: SessionDep,
    status: Literal["open", "upheld", "rejected"] = "open",
) -> list[DisputeOut]:
    return await claims.admin_disputes(session, status)


@router.post("/disputes/{dispute_id}/resolve", response_model=Message)
async def resolve_dispute(
    dispute_id: uuid.UUID,
    data: DisputeResolution,
    admin: AdminUser,
    session: SessionDep,
    ip: ClientIP,
) -> Message:
    dispute = await claims.resolve_dispute(session, admin, dispute_id, data.uphold, data.note, ip)
    return Message(message=f"Dispute {dispute.status}")


@router.get("/products", response_model=list[AdminProductOut])
async def list_products(
    _: AdminUser,
    session: SessionDep,
    status: Literal["pending_review", "rejected", "active"] = "pending_review",
) -> list[AdminProductOut]:
    return await catalog.admin_products(session, status)


@router.post("/products/{product_id}/{action}", response_model=Message)
async def review_product(
    product_id: uuid.UUID,
    action: Literal["approve", "reject"],
    data: Decision,
    admin: AdminUser,
    session: SessionDep,
    ip: ClientIP,
) -> Message:
    product = await catalog.admin_review_product(
        session, admin, product_id, action == "approve", data.reason, ip
    )
    return Message(message=f"Product {product.status}")
