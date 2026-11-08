"""Virtual shop unit claims: claim, review, release, renew, expire, transfer and dispute.

The database guarantees that a unit never has two live claims (partial unique index on
`property_claims(property_id) WHERE status IN ('pending','approved')`). Code here adds the
business rules: eligibility, per-merchant limits (checked under a lock on the merchant row),
evidence for units at real businesses, and the claim's lifecycle. Claims are virtual: they
grant a storefront in the 3D city, never any right to the real building.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.errors import AppError, bad_request, conflict, not_found
from app.geography.projection import default_projection
from app.marketplace.merchants import require_merchant, require_selling
from app.models import (
    Merchant,
    MerchantVerification,
    PropertyClaim,
    PropertyDispute,
    PropertyTransfer,
    Shop,
    User,
    VirtualProperty,
)
from app.schemas.market import (
    ClaimIn,
    ClaimOut,
    DisputeIn,
    DisputeOut,
    DocumentOut,
    TransferOut,
    UnitOut,
)
from app.services import audit
from app.utils.time import utcnow

LIVE = ("pending", "approved")
SHOP_COLOURS = [
    ("#c4552f", "#e8a33d"),
    ("#2f6f8f", "#f2c14e"),
    ("#3d7a4f", "#f4cf8e"),
    ("#7a3d6f", "#e6b8d8"),
    ("#8a5a2b", "#e9d3a8"),
    ("#1f5e5b", "#f28c6b"),
]


# ── units ────────────────────────────────────────────────────────────────────────────


def unit_out(
    unit: VirtualProperty, claim: PropertyClaim | None = None, shop_name: str | None = None
) -> UnitOut:
    projection = default_projection()
    lat, lon = projection.to_latlon(unit.door_x, unit.door_z)
    corners = [list(projection.to_latlon(x, z)) for x, z in unit.corners]
    if not unit.is_active:
        state = "inactive"
    elif claim is None or claim.status not in LIVE:
        state = "available"
    else:
        state = "claimed" if claim.status == "approved" else "pending"
    return UnitOut(
        code=unit.code,
        street_name=unit.street_name,
        street_name_km=unit.street_name_km,
        lat=round(lat, 7),
        lon=round(lon, 7),
        corners_ll=[[round(a, 7), round(b, 7)] for a, b in corners],
        width_m=unit.width_m,
        depth_m=unit.depth_m,
        requires_verification=unit.requires_verification,
        real_business_name=unit.real_business_name,
        status=state,
        shop_name=shop_name,
    )


async def unit_by_code(session: AsyncSession, code: str) -> VirtualProperty:
    unit = await session.scalar(
        select(VirtualProperty).where(VirtualProperty.code == code.strip().upper())
    )
    if unit is None:
        raise not_found("Unit")
    return unit


async def live_claim(session: AsyncSession, property_id: uuid.UUID) -> PropertyClaim | None:
    return await session.scalar(
        select(PropertyClaim).where(
            PropertyClaim.property_id == property_id, PropertyClaim.status.in_(LIVE)
        )
    )


async def list_units(
    session: AsyncSession,
    bbox: tuple[float, float, float, float],
    only_available: bool,
    limit: int = 800,
) -> list[UnitOut]:
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise bad_request("INVALID_BBOX", "bbox must be west,south,east,north")
    if (east - west) * (north - south) > 0.0004:  # about 2 km x 2 km
        raise bad_request("BBOX_TOO_LARGE", "Zoom in to see shop units.")
    stmt = (
        select(VirtualProperty, PropertyClaim, Shop.name)
        .outerjoin(
            PropertyClaim,
            (PropertyClaim.property_id == VirtualProperty.id) & PropertyClaim.status.in_(LIVE),
        )
        .outerjoin(Shop, (Shop.property_id == VirtualProperty.id) & (Shop.status == "active"))
        .where(
            VirtualProperty.is_active,
            func.ST_Intersects(
                VirtualProperty.footprint, func.ST_MakeEnvelope(west, south, east, north, 4326)
            ),
        )
        .order_by(VirtualProperty.code)
        .limit(limit)
    )
    if only_available:
        stmt = stmt.where(PropertyClaim.id.is_(None))
    rows = (await session.execute(stmt)).unique().all()
    return [unit_out(unit, claim, shop) for unit, claim, shop in rows]


async def unit_detail(session: AsyncSession, code: str) -> UnitOut:
    unit = await unit_by_code(session, code)
    claim = await live_claim(session, unit.id)
    shop = await session.scalar(
        select(Shop.name).where(Shop.property_id == unit.id, Shop.status == "active")
    )
    return unit_out(unit, claim, shop)


# ── outputs ──────────────────────────────────────────────────────────────────────────


async def claim_out(session: AsyncSession, claim: PropertyClaim) -> ClaimOut:
    shop_id = await session.scalar(
        select(Shop.id).where(Shop.claim_id == claim.id, Shop.status == "active")
    )
    merchant = await session.get(Merchant, claim.merchant_id)
    owner = await session.get(User, merchant.owner_id) if merchant else None
    document = await session.get(MerchantVerification, claim.document_id) if claim.document_id else None
    shop_name = await session.scalar(select(Shop.name).where(Shop.claim_id == claim.id))
    return ClaimOut(
        id=claim.id,
        unit=unit_out(claim.unit, claim, shop_name),
        status=claim.status,
        evidence_note=claim.evidence_note,
        decision_reason=claim.decision_reason,
        created_at=claim.created_at,
        decided_at=claim.decided_at,
        starts_at=claim.starts_at,
        expires_at=claim.expires_at,
        ended_at=claim.ended_at,
        shop_id=shop_id,
        merchant_name=merchant.business_name if merchant else None,
        merchant_username=owner.username if owner else None,
        document=DocumentOut.model_validate(document) if document else None,
    )


# ── lifecycle helpers ────────────────────────────────────────────────────────────────


def _open_shop(session: AsyncSession, claim: PropertyClaim, merchant: Merchant) -> Shop:
    primary, accent = SHOP_COLOURS[hash(merchant.id) % len(SHOP_COLOURS)]
    shop = Shop(
        merchant_id=merchant.id,
        property_id=claim.property_id,
        claim_id=claim.id,
        name=merchant.business_name[:60],
        name_km=(merchant.business_name_km or None) and merchant.business_name_km[:60],
        theme="cafe" if merchant.category == "food_drink" else "market",
        primary_color=primary,
        accent_color=accent,
        is_open=True,
        status="active",
    )
    session.add(shop)
    return shop


def _approve(claim: PropertyClaim) -> None:
    now = utcnow()
    claim.status = "approved"
    claim.starts_at = now
    claim.expires_at = now + timedelta(days=settings.claim_term_days)


async def end_claim(
    session: AsyncSession,
    claim: PropertyClaim,
    new_status: str,
    *,
    reason: str | None = None,
    actor: uuid.UUID | None = None,
) -> None:
    """Close a live claim: its storefront ends and pending transfers are cancelled."""
    now = utcnow()
    claim.status = new_status
    claim.ended_at = now
    if reason:
        claim.decision_reason = reason[:300]
    if actor:
        claim.decided_by_id, claim.decided_at = actor, now
    for shop in (
        await session.scalars(select(Shop).where(Shop.claim_id == claim.id, Shop.status == "active"))
    ).all():
        shop.status, shop.is_open = "ended", False
    for transfer in (
        await session.scalars(
            select(PropertyTransfer).where(
                PropertyTransfer.claim_id == claim.id, PropertyTransfer.status == "pending"
            )
        )
    ).all():
        transfer.status, transfer.decided_at = "cancelled", now


async def _live_count(session: AsyncSession, merchant_id: uuid.UUID) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(PropertyClaim)
            .where(PropertyClaim.merchant_id == merchant_id, PropertyClaim.status.in_(LIVE))
        )
        or 0
    )


async def _notify_world() -> None:
    from app.multiplayer.hub import hub

    await hub.shops_changed()


# ── merchant actions ─────────────────────────────────────────────────────────────────


async def claim_unit(session: AsyncSession, user: User, data: ClaimIn, ip: str) -> PropertyClaim:
    merchant = await require_merchant(session, user, lock=True)  # serialises this merchant
    require_selling(user, merchant)
    unit = await unit_by_code(session, data.unit_code)
    if not unit.is_active:
        raise conflict("UNIT_INACTIVE", "This unit is not available any more.")
    if await live_claim(session, unit.id) is not None:
        raise conflict("UNIT_TAKEN", f"Unit {unit.code} is already claimed.")
    if await _live_count(session, merchant.id) >= settings.max_units_per_merchant:
        raise conflict(
            "CLAIM_LIMIT",
            f"A merchant can hold up to {settings.max_units_per_merchant} units.",
        )
    document_id = None
    if data.document_id:
        document = await session.get(MerchantVerification, data.document_id)
        if document is None or document.merchant_id != merchant.id:
            raise not_found("Document")
        document_id = document.id
    claim = PropertyClaim(
        property_id=unit.id,
        merchant_id=merchant.id,
        evidence_note=data.evidence_note,
        document_id=document_id,
    )
    if unit.requires_verification:
        # A real, named business trades here. Nobody may take its frontage without evidence
        # and an administrator's review; the real owner can also dispute.
        if not (document_id and data.evidence_note):
            raise AppError(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "EVIDENCE_REQUIRED",
                f"Unit {unit.code} is at '{unit.real_business_name}', a real business. Attach "
                "a document and explain your connection to it; an administrator will review.",
            )
        claim.status = "pending"
        claim.expires_at = utcnow() + timedelta(days=settings.claim_pending_days)
    else:
        _approve(claim)
    session.add(claim)
    try:
        await session.flush()
    except IntegrityError as exc:
        # Lost a race with another merchant for the same unit: the unique index decided.
        await session.rollback()
        raise conflict("UNIT_TAKEN", f"Unit {unit.code} was just claimed by someone else.") from exc
    if claim.status == "approved":
        _open_shop(session, claim, merchant)
    audit.record(
        session,
        "claim.created",
        actor=user.id,
        target_type="unit",
        target_id=unit.code,
        ip=ip,
        status=claim.status,
    )
    await session.commit()
    if claim.status == "approved":
        await _notify_world()
    return claim


async def _own_claim(
    session: AsyncSession, user: User, claim_id: uuid.UUID
) -> tuple[Merchant, PropertyClaim]:
    merchant = await require_merchant(session, user)
    claim = await session.get(PropertyClaim, claim_id, with_for_update=True)
    if claim is None or claim.merchant_id != merchant.id:
        raise not_found("Claim")
    return merchant, claim


async def release(session: AsyncSession, user: User, claim_id: uuid.UUID, ip: str) -> None:
    _, claim = await _own_claim(session, user, claim_id)
    if claim.status not in LIVE:
        raise conflict("CLAIM_NOT_LIVE", f"This claim is {claim.status}.")
    was_open = claim.status == "approved"
    await end_claim(session, claim, "released")
    audit.record(session, "claim.released", actor=user.id, target_type="claim", target_id=claim.id, ip=ip)
    await session.commit()
    if was_open:
        await _notify_world()


async def renew(session: AsyncSession, user: User, claim_id: uuid.UUID) -> PropertyClaim:
    merchant, claim = await _own_claim(session, user, claim_id)
    require_selling(user, merchant)
    if claim.status != "approved":
        raise conflict("CLAIM_NOT_ACTIVE", "Only an active claim can be renewed.")
    claim.expires_at = utcnow() + timedelta(days=settings.claim_term_days)
    await session.commit()
    return claim


async def my_claims(session: AsyncSession, user: User) -> list[ClaimOut]:
    merchant = await require_merchant(session, user)
    claims = (
        await session.scalars(
            select(PropertyClaim)
            .where(PropertyClaim.merchant_id == merchant.id)
            .order_by(PropertyClaim.created_at.desc())
            .limit(50)
        )
    ).all()
    return [await claim_out(session, c) for c in claims]


# ── transfers ────────────────────────────────────────────────────────────────────────


async def offer_transfer(
    session: AsyncSession, user: User, claim_id: uuid.UUID, to_username: str, ip: str
) -> PropertyTransfer:
    merchant, claim = await _own_claim(session, user, claim_id)
    require_selling(user, merchant)
    if claim.status != "approved":
        raise conflict("CLAIM_NOT_ACTIVE", "Only an active claim can be transferred.")
    target_user = await session.scalar(select(User).where(User.username == to_username.lower()))
    target = (
        await session.scalar(select(Merchant).where(Merchant.owner_id == target_user.id))
        if target_user
        else None
    )
    if target is None or target.status != "approved" or target.id == merchant.id:
        raise bad_request("INVALID_RECIPIENT", "Transfer to another approved merchant.")
    transfer = PropertyTransfer(
        claim_id=claim.id, from_merchant_id=merchant.id, to_merchant_id=target.id
    )
    session.add(transfer)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise conflict("TRANSFER_PENDING", "A transfer of this unit is already pending.") from exc
    audit.record(
        session,
        "claim.transfer_offered",
        actor=user.id,
        target_type="claim",
        target_id=claim.id,
        ip=ip,
        to=target_user.username if target_user else None,
    )
    await session.commit()
    return transfer


async def respond_transfer(
    session: AsyncSession, user: User, transfer_id: uuid.UUID, accept: bool, ip: str
) -> None:
    merchant = await require_merchant(session, user, lock=True)
    transfer = await session.get(PropertyTransfer, transfer_id, with_for_update=True)
    if transfer is None or merchant.id not in (transfer.to_merchant_id, transfer.from_merchant_id):
        raise not_found("Transfer")
    if transfer.status != "pending":
        raise conflict("TRANSFER_DECIDED", f"This transfer is {transfer.status}.")
    is_recipient = merchant.id == transfer.to_merchant_id
    if not is_recipient:
        if accept:
            raise AppError(status.HTTP_403_FORBIDDEN, "FORBIDDEN", "Only the recipient can accept.")
        transfer.status, transfer.decided_at = "cancelled", utcnow()
        await session.commit()
        return
    if not accept:
        transfer.status, transfer.decided_at = "declined", utcnow()
        await session.commit()
        return
    require_selling(user, merchant)
    claim = await session.get(PropertyClaim, transfer.claim_id, with_for_update=True)
    if claim is None or claim.status != "approved":
        raise conflict("CLAIM_NOT_ACTIVE", "This unit is no longer held by the sender.")
    if await _live_count(session, merchant.id) >= settings.max_units_per_merchant:
        raise conflict(
            "CLAIM_LIMIT", f"A merchant can hold up to {settings.max_units_per_merchant} units."
        )
    expires = claim.expires_at
    transfer.status, transfer.decided_at = "accepted", utcnow()
    await end_claim(session, claim, "transferred")
    await session.flush()  # the old claim must stop being live before the new one exists
    new_claim = PropertyClaim(
        property_id=claim.property_id,
        merchant_id=merchant.id,
        status="approved",
        starts_at=utcnow(),
        expires_at=expires,
        evidence_note=f"Transferred from claim {claim.id}",
    )
    session.add(new_claim)
    await session.flush()
    _open_shop(session, new_claim, merchant)
    audit.record(
        session,
        "claim.transferred",
        actor=user.id,
        target_type="claim",
        target_id=claim.id,
        ip=ip,
        new_claim=str(new_claim.id),
    )
    await session.commit()
    await _notify_world()


async def my_transfers(session: AsyncSession, user: User) -> list[TransferOut]:
    merchant = await require_merchant(session, user)
    rows = (
        await session.scalars(
            select(PropertyTransfer)
            .where(
                (PropertyTransfer.to_merchant_id == merchant.id)
                | (PropertyTransfer.from_merchant_id == merchant.id)
            )
            .order_by(PropertyTransfer.created_at.desc())
            .limit(30)
        )
    ).all()
    out = []
    for t in rows:
        claim = await session.get(PropertyClaim, t.claim_id)
        source = await session.get(Merchant, t.from_merchant_id)
        target = await session.get(Merchant, t.to_merchant_id)
        out.append(
            TransferOut(
                id=t.id,
                unit_code=claim.unit.code if claim else "?",
                from_merchant=source.business_name if source else "?",
                to_merchant=target.business_name if target else "?",
                status=t.status,
                created_at=t.created_at,
                direction="incoming" if t.to_merchant_id == merchant.id else "outgoing",
            )
        )
    return out


# ── disputes ─────────────────────────────────────────────────────────────────────────


async def open_dispute(
    session: AsyncSession, user: User, data: DisputeIn, ip: str
) -> PropertyDispute:
    if not user.contact_verified:
        raise AppError(status.HTTP_403_FORBIDDEN, "VERIFY_FIRST", "Verify your e-mail or phone first.")
    unit = await unit_by_code(session, data.unit_code)
    claim = await live_claim(session, unit.id)
    if claim is None:
        raise conflict("NOTHING_TO_DISPUTE", "Nobody holds this unit; you can claim it instead.")
    merchant = await session.get(Merchant, claim.merchant_id)
    if merchant and merchant.owner_id == user.id:
        raise bad_request("OWN_CLAIM", "You cannot dispute your own claim.")
    duplicate = await session.scalar(
        select(PropertyDispute.id).where(
            PropertyDispute.property_id == unit.id,
            PropertyDispute.disputer_id == user.id,
            PropertyDispute.status == "open",
        )
    )
    if duplicate:
        raise conflict("DISPUTE_OPEN", "You already have an open dispute for this unit.")
    dispute = PropertyDispute(
        property_id=unit.id,
        claim_id=claim.id,
        disputer_id=user.id,
        reason=data.reason,
        contact=data.contact,
    )
    session.add(dispute)
    await session.flush()
    audit.record(
        session, "claim.disputed", actor=user.id, target_type="unit", target_id=unit.code, ip=ip
    )
    await session.commit()
    return dispute


async def dispute_out(session: AsyncSession, dispute: PropertyDispute) -> DisputeOut:
    unit = await session.get(VirtualProperty, dispute.property_id)
    claim = await session.get(PropertyClaim, dispute.claim_id) if dispute.claim_id else None
    merchant = await session.get(Merchant, claim.merchant_id) if claim else None
    disputer = await session.get(User, dispute.disputer_id)
    return DisputeOut(
        id=dispute.id,
        unit_code=unit.code if unit else "?",
        real_business_name=unit.real_business_name if unit else None,
        claim_id=dispute.claim_id,
        claimed_by=merchant.business_name if merchant else None,
        disputer=disputer.username if disputer else "?",
        reason=dispute.reason,
        contact=dispute.contact,
        status=dispute.status,
        resolution_note=dispute.resolution_note,
        created_at=dispute.created_at,
    )


# ── administration ───────────────────────────────────────────────────────────────────


async def admin_claims(session: AsyncSession, status_filter: str) -> list[ClaimOut]:
    claims = (
        await session.scalars(
            select(PropertyClaim)
            .where(PropertyClaim.status == status_filter)
            .order_by(PropertyClaim.created_at)
            .limit(100)
        )
    ).all()
    return [await claim_out(session, c) for c in claims]


async def admin_decide(
    session: AsyncSession,
    admin: User,
    claim_id: uuid.UUID,
    action: str,
    reason: str | None,
    ip: str,
) -> PropertyClaim:
    claim = await session.get(PropertyClaim, claim_id, with_for_update=True)
    if claim is None:
        raise not_found("Claim")
    if action in ("approve", "reject") and claim.status != "pending":
        raise conflict("ALREADY_DECIDED", f"This claim is {claim.status}.")
    if action == "revoke" and claim.status not in LIVE:
        raise conflict("CLAIM_NOT_LIVE", f"This claim is {claim.status}.")
    notify = False
    if action == "approve":
        merchant = await session.get(Merchant, claim.merchant_id)
        if merchant is None or merchant.status != "approved":
            raise conflict("MERCHANT_NOT_APPROVED", "Approve the merchant first.")
        _approve(claim)
        claim.decided_by_id, claim.decided_at, claim.decision_reason = admin.id, utcnow(), reason
        _open_shop(session, claim, merchant)
        notify = True
    elif action == "reject":
        await end_claim(session, claim, "rejected", reason=reason, actor=admin.id)
    else:
        notify = claim.status == "approved"
        await end_claim(session, claim, "revoked", reason=reason, actor=admin.id)
    audit.record(
        session,
        f"claim.{action}",
        actor=admin.id,
        target_type="claim",
        target_id=claim.id,
        ip=ip,
        reason=reason,
    )
    await session.commit()
    if notify:
        await _notify_world()
    return claim


async def admin_disputes(session: AsyncSession, status_filter: str) -> list[DisputeOut]:
    rows = (
        await session.scalars(
            select(PropertyDispute)
            .where(PropertyDispute.status == status_filter)
            .order_by(PropertyDispute.created_at)
            .limit(100)
        )
    ).all()
    return [await dispute_out(session, d) for d in rows]


async def resolve_dispute(
    session: AsyncSession,
    admin: User,
    dispute_id: uuid.UUID,
    uphold: bool,
    note: str | None,
    ip: str,
) -> PropertyDispute:
    dispute = await session.get(PropertyDispute, dispute_id, with_for_update=True)
    if dispute is None:
        raise not_found("Dispute")
    if dispute.status != "open":
        raise conflict("ALREADY_DECIDED", f"This dispute is {dispute.status}.")
    notify = False
    if uphold and dispute.claim_id:
        claim = await session.get(PropertyClaim, dispute.claim_id, with_for_update=True)
        if claim is not None and claim.status in LIVE:
            notify = claim.status == "approved"
            await end_claim(
                session, claim, "revoked", reason=note or "Dispute upheld", actor=admin.id
            )
    dispute.status = "upheld" if uphold else "rejected"
    dispute.resolution_note, dispute.decided_by_id, dispute.decided_at = note, admin.id, utcnow()
    audit.record(
        session,
        "dispute.upheld" if uphold else "dispute.rejected",
        actor=admin.id,
        target_type="dispute",
        target_id=dispute.id,
        ip=ip,
        note=note,
    )
    await session.commit()
    if notify:
        await _notify_world()
    return dispute


# ── expiry ───────────────────────────────────────────────────────────────────────────


async def expire_due(session: AsyncSession) -> int:
    """Approved claims past their term and pending claims past their review window expire."""
    due = (
        await session.scalars(
            select(PropertyClaim)
            .where(PropertyClaim.status.in_(LIVE), PropertyClaim.expires_at <= utcnow())
            .with_for_update(skip_locked=True)
            .limit(200)
        )
    ).all()
    notify = any(c.status == "approved" for c in due)
    for claim in due:
        await end_claim(session, claim, "expired", reason="Claim term ended")
    if due:
        await session.commit()
        if notify:
            await _notify_world()
    return len(due)
