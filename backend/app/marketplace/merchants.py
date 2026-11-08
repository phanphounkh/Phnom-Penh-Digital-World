"""Merchant applications, verification documents and administrator decisions.

Becoming a seller is one application: the business details (plus optional documents) and a
pending `seller` role. Approving the merchant activates the seller role in the same step.
"""

from __future__ import annotations

import uuid

from fastapi import UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, not_found
from app.marketplace import media
from app.models import (
    Merchant,
    MerchantVerification,
    RoleName,
    RoleStatus,
    Shop,
    User,
    UserRole,
)
from app.schemas.market import AdminMerchantOut, DocumentOut, MerchantIn, MerchantOut
from app.services import audit
from app.utils.time import utcnow

MAX_DOCUMENTS = 10


def seller_role(user: User) -> UserRole | None:
    return next((r for r in user.roles if r.role == RoleName.SELLER), None)


async def merchant_of(session: AsyncSession, user: User, *, lock: bool = False) -> Merchant | None:
    stmt = select(Merchant).where(Merchant.owner_id == user.id)
    if lock:
        stmt = stmt.with_for_update()
    return await session.scalar(stmt)


async def require_merchant(session: AsyncSession, user: User, *, lock: bool = False) -> Merchant:
    merchant = await merchant_of(session, user, lock=lock)
    if merchant is None:
        raise AppError(
            status.HTTP_404_NOT_FOUND, "NO_MERCHANT", "Apply as a merchant first (Seller page)."
        )
    return merchant


def require_selling(user: User, merchant: Merchant) -> None:
    """Approved merchant with an active seller role: may claim units and trade."""
    if merchant.status != "approved" or not user.has_role(RoleName.SELLER):
        reason = {
            "pending": "Your merchant application is still being reviewed.",
            "rejected": "Your merchant application was not approved.",
            "suspended": "Your merchant account is suspended.",
        }.get(merchant.status, "Your seller role is not active.")
        raise AppError(status.HTTP_403_FORBIDDEN, "NOT_ELIGIBLE", reason)


async def documents_of(session: AsyncSession, merchant_id: uuid.UUID) -> list[MerchantVerification]:
    return list(
        (
            await session.scalars(
                select(MerchantVerification)
                .where(MerchantVerification.merchant_id == merchant_id)
                .order_by(MerchantVerification.created_at)
            )
        ).all()
    )


async def merchant_out(session: AsyncSession, merchant: Merchant, owner: User) -> MerchantOut:
    out = MerchantOut.model_validate(merchant, from_attributes=True)
    out.documents = [
        DocumentOut.model_validate(d) for d in await documents_of(session, merchant.id)
    ]
    role = seller_role(owner)
    out.seller_role = role.status if role else None
    return out


async def apply(session: AsyncSession, user: User, data: MerchantIn, ip: str) -> Merchant:
    if not user.contact_verified:
        raise AppError(
            status.HTTP_403_FORBIDDEN, "VERIFY_FIRST", "Verify your e-mail or phone first."
        )
    merchant = await merchant_of(session, user, lock=True)
    fields = data.model_dump()
    if merchant is not None and merchant.status != "rejected":
        raise conflict("ALREADY_APPLIED", "You already have a merchant profile; edit it instead.")
    if merchant is None:
        merchant = Merchant(owner_id=user.id, status="pending", **fields)
        session.add(merchant)
    else:  # re-applying after a rejection
        for key, value in fields.items():
            setattr(merchant, key, value)
        merchant.status = "pending"
        merchant.decided_at = merchant.decided_by_id = merchant.decision_reason = None
    role = seller_role(user)
    now = utcnow()
    if role is None:
        user.roles.append(
            UserRole(role=RoleName.SELLER, status=RoleStatus.PENDING, requested_at=now)
        )
    elif role.status in (RoleStatus.REJECTED, RoleStatus.REVOKED):
        role.status, role.requested_at = RoleStatus.PENDING, now
        role.decided_at = role.decided_by_id = role.decision_reason = None
    await session.flush()
    audit.record(
        session,
        "merchant.applied",
        actor=user.id,
        target_type="merchant",
        target_id=merchant.id,
        ip=ip,
        business=data.business_name,
    )
    await session.commit()
    return merchant


async def update(session: AsyncSession, user: User, data: MerchantIn) -> Merchant:
    merchant = await require_merchant(session, user, lock=True)
    if merchant.status == "suspended":
        raise AppError(status.HTTP_403_FORBIDDEN, "SUSPENDED", "This merchant is suspended.")
    for key, value in data.model_dump().items():
        setattr(merchant, key, value)
    await session.commit()
    return merchant


async def add_document(
    session: AsyncSession, user: User, kind: str, upload: UploadFile, ip: str
) -> MerchantVerification:
    merchant = await require_merchant(session, user, lock=True)
    if len(await documents_of(session, merchant.id)) >= MAX_DOCUMENTS:
        raise conflict("TOO_MANY_DOCUMENTS", f"Up to {MAX_DOCUMENTS} documents.")
    stored = await media.save_document(upload)
    doc = MerchantVerification(
        merchant_id=merchant.id,
        kind=kind,
        original_name=stored.original_name,
        stored_name=stored.stored_name,
        content_type=stored.content_type,
        size_bytes=stored.size_bytes,
        sha256=stored.sha256,
    )
    session.add(doc)
    await session.flush()
    audit.record(
        session,
        "merchant.document_added",
        actor=user.id,
        target_type="merchant",
        target_id=merchant.id,
        ip=ip,
        kind=kind,
        size=stored.size_bytes,
    )
    await session.commit()
    return doc


# ── administration ───────────────────────────────────────────────────────────────────


async def admin_list(session: AsyncSession, status_filter: str | None) -> list[AdminMerchantOut]:
    stmt = select(Merchant, User).join(User, User.id == Merchant.owner_id)
    if status_filter:
        stmt = stmt.where(Merchant.status == status_filter)
    out = []
    for merchant, owner in (await session.execute(stmt.order_by(Merchant.created_at))).all():
        base = await merchant_out(session, merchant, owner)
        out.append(
            AdminMerchantOut(
                **base.model_dump(),
                owner_username=owner.username,
                owner_display_name=owner.profile.display_name if owner.profile else owner.username,
            )
        )
    return out


async def decide(
    session: AsyncSession,
    admin: User,
    merchant_id: uuid.UUID,
    action: str,
    reason: str | None,
    ip: str,
) -> Merchant:
    merchant = await session.get(Merchant, merchant_id, with_for_update=True)
    if merchant is None:
        raise not_found("Merchant")
    allowed = {
        "approve": {"pending", "rejected", "suspended"},
        "reject": {"pending"},
        "suspend": {"approved"},
    }[action]
    if merchant.status not in allowed:
        raise conflict("INVALID_TRANSITION", f"This merchant is {merchant.status}.")
    owner = await session.get(User, merchant.owner_id)
    assert owner is not None
    now = utcnow()
    merchant.status = {"approve": "approved", "reject": "rejected", "suspend": "suspended"}[action]
    merchant.decided_at, merchant.decided_by_id, merchant.decision_reason = now, admin.id, reason
    role = seller_role(owner)
    if action == "approve":
        if role is None:
            owner.roles.append(
                UserRole(
                    role=RoleName.SELLER,
                    status=RoleStatus.ACTIVE,
                    requested_at=now,
                    decided_at=now,
                    decided_by_id=admin.id,
                )
            )
        elif role.status != RoleStatus.ACTIVE:
            role.status, role.decided_at, role.decided_by_id = RoleStatus.ACTIVE, now, admin.id
            role.decision_reason = reason
    elif action == "reject" and role is not None and role.status == RoleStatus.PENDING:
        role.status, role.decided_at, role.decided_by_id = RoleStatus.REJECTED, now, admin.id
        role.decision_reason = reason
    elif action == "suspend":
        for shop in (
            await session.scalars(
                select(Shop).where(Shop.merchant_id == merchant.id, Shop.status == "active")
            )
        ).all():
            shop.is_open = False
    for doc in await documents_of(session, merchant.id):
        if doc.status == "submitted" and action in ("approve", "reject"):
            doc.status = "accepted" if action == "approve" else "rejected"
            doc.reviewed_by_id, doc.reviewed_at = admin.id, now
    audit.record(
        session,
        f"merchant.{action}",
        actor=admin.id,
        target_type="merchant",
        target_id=merchant.id,
        ip=ip,
        reason=reason,
    )
    await session.commit()
    return merchant


async def document_for_admin(session: AsyncSession, document_id: uuid.UUID) -> MerchantVerification:
    doc = await session.get(MerchantVerification, document_id)
    if doc is None:
        raise not_found("Document")
    return doc
