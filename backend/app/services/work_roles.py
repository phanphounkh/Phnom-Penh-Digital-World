"""Work roles (seller, driver): registered at the System Office in the city, one at a time.

Every player can buy. To sell or deliver they go to the office's counter in the 3D city (the
server checks they are there, from their live position) and register one work role: a seller
sends their business details (a merchant application), a driver a short note. An administrator
approves either. A player leaves a role at the same counter before registering another.
"""

from __future__ import annotations

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.marketplace import merchants
from app.models import PropertyClaim, User, UserRole
from app.models.enums import RoleName, RoleStatus
from app.multiplayer.buildings import SYSTEM_OFFICE
from app.multiplayer.hub import hub
from app.schemas.me import WorkRoleIn
from app.services import audit
from app.services.onboarding import WORK_ROLES
from app.utils.time import utcnow

LIVE = (RoleStatus.ACTIVE, RoleStatus.PENDING)


def current(user: User) -> UserRole | None:
    """The player's work role, active or waiting for approval (at most one)."""
    return next((r for r in user.roles if r.role in WORK_ROLES and r.status in LIVE), None)


def _at_the_office(user: User) -> None:
    if not hub.at_building(user.id, SYSTEM_OFFICE):
        raise AppError(
            status.HTTP_403_FORBIDDEN,
            "AT_THE_OFFICE",
            "Work roles are registered at the System Office in the city: go to its counter.",
        )


def _conflict(code: str, message: str) -> AppError:
    return AppError(status.HTTP_409_CONFLICT, code, message)


async def register(session: AsyncSession, user: User, data: WorkRoleIn, ip: str) -> None:
    if user.onboarding_completed_at is None:
        raise _conflict("ONBOARDING_INCOMPLETE", "Finish setting up your account first.")
    _at_the_office(user)
    have = current(user)
    if have is not None:
        state = "waiting for approval" if have.status == RoleStatus.PENDING else "active"
        if have.role == data.role:
            raise _conflict("ALREADY_REGISTERED", f"You are already a {have.role} ({state}).")
        raise _conflict(
            "ONE_WORK_ROLE",
            f"You are a {have.role} ({state}). One work role at a time: leave it first.",
        )
    if data.role == RoleName.SELLER:
        if data.business is None:
            raise AppError(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "BUSINESS_REQUIRED",
                "Tell us about your business to register as a seller.",
            )
        await merchants.apply(session, user, data.business, ip)  # the seller role, pending
        return
    now = utcnow()
    row = next((r for r in user.roles if r.role == RoleName.DRIVER), None)
    if row is None:
        user.roles.append(
            UserRole(
                role=RoleName.DRIVER,
                status=RoleStatus.PENDING,
                note=data.note,
                requested_at=now,
            )
        )
    else:  # again, after a rejection or after leaving
        row.status, row.requested_at, row.note = RoleStatus.PENDING, now, data.note
        row.decided_at = row.decided_by_id = row.decision_reason = None
    audit.record(
        session,
        "role.requested",
        actor=user.id,
        target_type="user",
        target_id=user.id,
        role=RoleName.DRIVER.value,
        status="pending",
        where="system_office",
    )
    await session.commit()


async def leave(session: AsyncSession, user: User) -> None:
    _at_the_office(user)
    have = current(user)
    if have is None:
        raise _conflict("NO_WORK_ROLE", "You have no work role to leave.")
    if have.role == RoleName.SELLER:
        merchant = await merchants.merchant_of(session, user, lock=True)
        if merchant is not None:
            spots = await session.scalar(
                select(func.count())
                .select_from(PropertyClaim)
                .where(
                    PropertyClaim.merchant_id == merchant.id,
                    PropertyClaim.status.in_(("pending", "approved")),
                )
            )
            if spots:
                raise _conflict(
                    "RELEASE_UNITS_FIRST",
                    "Release your shop's spot first: your shop closes with it.",
                )
            if merchant.status == "pending":  # withdrawn: off the administrators' queue
                merchant.status = "rejected"
                merchant.decision_reason = "Withdrawn by the applicant"
    have.status, have.decided_at = RoleStatus.REVOKED, utcnow()
    audit.record(
        session,
        "role.withdrawn",
        actor=user.id,
        target_type="user",
        target_id=user.id,
        role=have.role,
        where="system_office",
    )
    await session.commit()
