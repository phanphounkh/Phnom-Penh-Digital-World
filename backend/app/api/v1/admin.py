"""Administrator endpoints (Phase 1: role-request review and the user list)."""

import uuid
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import aliased

from app.api.deps import AdminUser, ClientIP, SessionDep
from app.core.errors import AppError, not_found
from app.models import AuthSession, PlayerReport, RoleStatus, User, UserRole
from app.multiplayer.hub import hub
from app.schemas.common import Message
from app.services import audit
from app.utils.time import utcnow

router = APIRouter(prefix="/admin", tags=["admin"])


class RoleRequestOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    username: str
    display_name: str
    role: str
    status: str
    note: str | None
    requested_at: datetime
    decided_at: datetime | None
    decision_reason: str | None


class Decision(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class AdminUserOut(BaseModel):
    id: uuid.UUID
    username: str
    display_name: str
    contact_verified: bool
    active_roles: list[str]
    onboarding_completed: bool
    is_active: bool
    created_at: datetime


def _request_out(row: UserRole) -> RoleRequestOut:
    return RoleRequestOut(
        id=row.id,
        user_id=row.user_id,
        username=row.user.username,
        display_name=row.user.profile.display_name if row.user.profile else row.user.username,
        role=row.role,
        status=row.status,
        note=row.note,
        requested_at=row.requested_at,
        decided_at=row.decided_at,
        decision_reason=row.decision_reason,
    )


@router.get("/role-requests", response_model=list[RoleRequestOut])
async def role_requests(
    _: AdminUser,
    session: SessionDep,
    status: Literal["pending", "active", "rejected", "revoked"] = "pending",
) -> list[RoleRequestOut]:
    rows = await session.scalars(
        select(UserRole)
        .where(UserRole.status == status, UserRole.role.in_(("seller", "driver")))
        .order_by(UserRole.requested_at)
        .limit(200)
    )
    result = []
    for row in rows:
        await session.refresh(row, ["user"])
        result.append(_request_out(row))
    return result


async def _decide(
    session: SessionDep,
    admin: User,
    request_id: uuid.UUID,
    approve: bool,
    reason: str | None,
    ip: str,
) -> RoleRequestOut:
    row = await session.get(UserRole, request_id, with_for_update=True)
    if row is None or row.role not in ("seller", "driver"):
        raise not_found("Role request")
    if row.status != RoleStatus.PENDING:
        raise AppError(409, "ALREADY_DECIDED", f"This request is already {row.status}.")
    row.status = RoleStatus.ACTIVE if approve else RoleStatus.REJECTED
    row.decided_at, row.decided_by_id, row.decision_reason = utcnow(), admin.id, reason
    audit.record(
        session,
        "role.approved" if approve else "role.rejected",
        actor=admin.id,
        target_type="user",
        target_id=row.user_id,
        ip=ip,
        role=row.role,
        reason=reason,
    )
    await session.commit()
    await session.refresh(row, ["user"])
    return _request_out(row)


@router.post("/role-requests/{request_id}/approve", response_model=RoleRequestOut)
async def approve(
    request_id: uuid.UUID, data: Decision, admin: AdminUser, session: SessionDep, ip: ClientIP
) -> RoleRequestOut:
    return await _decide(session, admin, request_id, True, data.reason, ip)


@router.post("/role-requests/{request_id}/reject", response_model=RoleRequestOut)
async def reject(
    request_id: uuid.UUID, data: Decision, admin: AdminUser, session: SessionDep, ip: ClientIP
) -> RoleRequestOut:
    return await _decide(session, admin, request_id, False, data.reason, ip)


@router.get("/users", response_model=list[AdminUserOut])
async def users(
    _: AdminUser,
    session: SessionDep,
    q: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
) -> list[AdminUserOut]:
    stmt = select(User).order_by(User.created_at.desc()).limit(limit)
    if q:
        stmt = stmt.where(func.lower(User.username).contains(q.lower()))
    return [
        AdminUserOut(
            id=u.id,
            username=u.username,
            display_name=u.profile.display_name if u.profile else u.username,
            contact_verified=u.contact_verified,
            active_roles=u.active_roles,
            onboarding_completed=u.onboarding_completed_at is not None,
            is_active=u.is_active,
            created_at=u.created_at,
        )
        for u in await session.scalars(stmt)
    ]


# ── moderation ──────────────────────────────────────────────────────────────────────────
class ReportOut(BaseModel):
    id: uuid.UUID
    reporter: str
    reported: str
    reported_display_name: str
    reason: str
    details: str | None
    context: dict
    status: str
    action: str | None
    resolution_note: str | None
    created_at: datetime


class Resolution(BaseModel):
    action: Literal["dismiss", "warn", "chat_mute", "suspend"]
    hours: int = Field(default=24, ge=1, le=24 * 90)
    note: str | None = Field(default=None, max_length=1000)


@router.get("/reports", response_model=list[ReportOut])
async def reports(
    _: AdminUser,
    session: SessionDep,
    status: Literal["open", "resolved", "dismissed"] = "open",
) -> list[ReportOut]:
    reporter = aliased(User)
    reported = aliased(User)
    rows = await session.execute(
        select(PlayerReport, reporter, reported)
        .join(reporter, reporter.id == PlayerReport.reporter_id)
        .join(reported, reported.id == PlayerReport.reported_id)
        .where(PlayerReport.status == status)
        .order_by(PlayerReport.created_at.desc())
        .limit(200)
    )
    return [
        ReportOut(
            id=r.id,
            reporter=a.username,
            reported=b.username,
            reported_display_name=b.profile.display_name if b.profile else b.username,
            reason=r.reason,
            details=r.details,
            context=r.context,
            status=r.status,
            action=r.action,
            resolution_note=r.resolution_note,
            created_at=r.created_at,
        )
        for r, a, b in rows
    ]


@router.post("/reports/{report_id}/resolve", response_model=Message)
async def resolve_report(
    report_id: uuid.UUID, data: Resolution, admin: AdminUser, session: SessionDep, ip: ClientIP
) -> Message:
    row = await session.get(PlayerReport, report_id, with_for_update=True)
    if row is None:
        raise not_found("Report")
    if row.status != "open":
        raise AppError(409, "ALREADY_RESOLVED", "This report is already closed.")
    target = await session.get(User, row.reported_id)
    now = utcnow()
    until = None
    if data.action == "chat_mute":
        until = now + timedelta(hours=data.hours)
        target.profile.chat_muted_until = until
    elif data.action == "suspend":
        target.is_active = False
        await session.execute(
            update(AuthSession)
            .where(AuthSession.user_id == target.id, AuthSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )
    row.status = "dismissed" if data.action == "dismiss" else "resolved"
    row.action, row.resolution_note = data.action, data.note
    row.resolved_by_id, row.resolved_at = admin.id, now
    audit.record(
        session,
        f"moderation.{data.action}",
        actor=admin.id,
        target_type="user",
        target_id=target.id,
        ip=ip,
        report_id=str(row.id),
        hours=data.hours,
    )
    await session.commit()
    # Apply to a live world session immediately.
    if data.action == "chat_mute":
        hub.set_chat_mute(target.id, until)
        hub.notify_user(
            target.id,
            {
                "t": "notify",
                "kind": "moderation",
                "text": f"Your chat is muted for {data.hours} h.",
            },
        )
    elif data.action == "warn":
        hub.notify_user(
            target.id,
            {
                "t": "notify",
                "kind": "moderation",
                "text": "A moderator has warned you about your behaviour.",
            },
        )
    elif data.action == "suspend":
        await hub.kick_user(target.id, "suspended")
    return Message(message=f"Report {row.status}")
