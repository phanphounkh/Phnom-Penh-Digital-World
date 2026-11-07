"""Onboarding state machine:  verify → avatar → role → location → complete → world.

Every step is validated server-side; the client only renders what the API reports.
"""

import uuid

from fastapi import status
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, not_found
from app.models import (
    AvatarCustomization,
    PlayerSpawnPoint,
    RoleName,
    RoleStatus,
    User,
    UserAddress,
    UserRole,
)
from app.models.enums import SELF_SERVICE_ROLES
from app.schemas.auth import MeOut, OnboardingOut, RoleOut
from app.schemas.me import AddressIn, AddressOut, RoleSelection
from app.services import audit
from app.utils.time import utcnow


def _forbidden(code: str, message: str) -> AppError:
    return AppError(status.HTTP_403_FORBIDDEN, code, message)


def wants_buyer(user: User) -> bool:
    return any(r.role == RoleName.BUYER and r.status in ("active", "pending") for r in user.roles)


async def onboarding_state(session: AsyncSession, user: User) -> OnboardingOut:
    profile = user.profile
    has_avatar = (
        await session.scalar(
            select(func.count())
            .select_from(AvatarCustomization)
            .where(AvatarCustomization.user_id == user.id)
        )
    ) > 0
    has_address = (
        await session.scalar(
            select(func.count()).select_from(UserAddress).where(UserAddress.user_id == user.id)
        )
    ) > 0
    roles_done = bool(profile and profile.roles_chosen_at)
    needs_address = wants_buyer(user)
    location_done = bool(
        profile
        and profile.spawn_point_id
        and profile.world_visible is not None
        and (has_address or not needs_address)
    )
    steps = [
        ("verify", user.contact_verified),
        ("avatar", has_avatar),
        ("role", roles_done),
        ("location", location_done),
    ]
    completed = user.onboarding_completed_at is not None
    next_step = next(
        (name for name, done in steps if not done), "world" if completed else "complete"
    )
    return OnboardingOut(
        verified=user.contact_verified,
        avatar=has_avatar,
        roles=roles_done,
        location=location_done,
        needs_address=needs_address,
        completed=completed,
        next_step=next_step,
    )


async def me_out(session: AsyncSession, user: User) -> MeOut:
    await session.refresh(user, ["roles", "profile"])
    profile = user.profile
    return MeOut(
        id=user.id,
        username=user.username,
        display_name=profile.display_name if profile else user.username,
        email=user.email,
        phone=user.phone,
        email_verified=user.email_verified_at is not None,
        phone_verified=user.phone_verified_at is not None,
        preferred_language=profile.preferred_language if profile else "en",
        world_visible=profile.world_visible if profile else None,
        roles=[
            RoleOut(
                role=r.role,
                status=r.status,
                requested_at=r.requested_at,
                decided_at=r.decided_at,
                decision_reason=r.decision_reason,
            )
            for r in sorted(user.roles, key=lambda r: r.role)
        ],
        active_roles=user.active_roles,
        onboarding=await onboarding_state(session, user),
        created_at=user.created_at,
    )


# ── roles ───────────────────────────────────────────────────────────────────────────────
async def select_roles(session: AsyncSession, user: User, data: RoleSelection) -> None:
    if not user.contact_verified:
        raise _forbidden("VERIFY_FIRST", "Verify your email or phone number first.")
    wanted = {RoleName(r) for r in data.roles} | {RoleName.VISITOR}
    now = utcnow()
    existing = {r.role: r for r in user.roles}
    for role in wanted:
        needs_review = SELF_SERVICE_ROLES[role]
        note = (
            data.seller_note
            if role == RoleName.SELLER
            else (data.driver_note if role == RoleName.DRIVER else None)
        )
        row = existing.get(role)
        if row is None:
            user.roles.append(
                UserRole(
                    role=role,
                    status=RoleStatus.PENDING if needs_review else RoleStatus.ACTIVE,
                    note=note,
                    requested_at=now,
                    decided_at=None if needs_review else now,
                )
            )
            audit.record(
                session,
                "role.requested",
                actor=user.id,
                target_type="user",
                target_id=user.id,
                role=role.value,
                status="pending" if needs_review else "active",
            )
        elif row.status in (RoleStatus.REJECTED, RoleStatus.REVOKED):
            # Re-apply after a rejection: back into the review queue (or active for buyer).
            row.status = RoleStatus.PENDING if needs_review else RoleStatus.ACTIVE
            row.requested_at, row.note = now, note
            row.decided_at = None if needs_review else now
            row.decided_by_id, row.decision_reason = None, None
            audit.record(
                session,
                "role.requested",
                actor=user.id,
                target_type="user",
                target_id=user.id,
                role=role.value,
                status=row.status,
                reapply=True,
            )
    # Self-service roles the user unticked are withdrawn (admin roles are never touched here).
    for role, row in existing.items():
        if (
            role in SELF_SERVICE_ROLES
            and role not in wanted
            and row.status in ("active", "pending")
        ):
            row.status, row.decided_at = RoleStatus.REVOKED, now
            audit.record(
                session,
                "role.withdrawn",
                actor=user.id,
                target_type="user",
                target_id=user.id,
                role=role,
            )
    user.profile.roles_chosen_at = now


# ── private addresses ───────────────────────────────────────────────────────────────────
async def in_service_area(session: AsyncSession, lat: float, lon: float) -> bool:
    return bool(
        await session.scalar(
            text("""
        SELECT EXISTS (
          SELECT 1 FROM geographic_regions
          WHERE is_service_area
            AND ST_Contains(boundary, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326))
        )"""),
            {"lat": lat, "lon": lon},
        )
    )


def _address_out(row: object) -> AddressOut:
    return AddressOut.model_validate(row, from_attributes=True)


_ADDRESS_COLUMNS = """
    id, label, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon,
    address_line, details, is_default, created_at
"""


async def list_addresses(session: AsyncSession, user_id: uuid.UUID) -> list[AddressOut]:
    rows = await session.execute(
        text(
            f"SELECT {_ADDRESS_COLUMNS} FROM user_addresses WHERE user_id = :uid "
            "ORDER BY is_default DESC, created_at"
        ),
        {"uid": user_id},
    )
    return [_address_out(r) for r in rows]


async def add_address(
    session: AsyncSession, user: User, data: AddressIn, ip: str | None
) -> AddressOut:
    if not await in_service_area(session, data.lat, data.lon):
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "OUTSIDE_SERVICE_AREA",
            "Delivery addresses must be inside Phnom Penh.",
        )
    count = await session.scalar(
        select(func.count()).select_from(UserAddress).where(UserAddress.user_id == user.id)
    )
    if count >= 10:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "TOO_MANY_ADDRESSES",
            "You can save up to 10 addresses.",
        )
    is_default = data.is_default or count == 0
    if is_default:
        await session.execute(
            update(UserAddress).where(UserAddress.user_id == user.id).values(is_default=False)
        )
    address = UserAddress(
        id=uuid.uuid4(),
        user_id=user.id,
        label=data.label.strip(),
        location=f"SRID=4326;POINT({data.lon} {data.lat})",
        address_line=data.address_line.strip(),
        details=data.details,
        is_default=is_default,
    )
    session.add(address)
    await session.flush()
    # Never log coordinates or the address text: only that an address exists.
    audit.record(
        session,
        "address.created",
        actor=user.id,
        target_type="address",
        target_id=address.id,
        ip=ip,
    )
    rows = await session.execute(
        text(f"SELECT {_ADDRESS_COLUMNS} FROM user_addresses WHERE id = :id"),
        {"id": address.id},
    )
    return _address_out(rows.one())


async def delete_address(session: AsyncSession, user: User, address_id: uuid.UUID) -> None:
    address = await session.get(UserAddress, address_id)
    # Someone else's address is indistinguishable from a missing one.
    if address is None or address.user_id != user.id:
        raise not_found("Address")
    await session.delete(address)
    audit.record(
        session, "address.deleted", actor=user.id, target_type="address", target_id=address_id
    )


# ── spawn / completion ──────────────────────────────────────────────────────────────────
async def choose_spawn(
    session: AsyncSession, user: User, spawn_point_id: uuid.UUID, world_visible: bool
) -> None:
    spawn = await session.get(PlayerSpawnPoint, spawn_point_id)
    if spawn is None or not spawn.is_active:
        raise not_found("Spawn point")
    user.profile.spawn_point_id = spawn.id
    user.profile.world_visible = world_visible


async def complete(session: AsyncSession, user: User) -> OnboardingOut:
    state = await onboarding_state(session, user)
    if state.next_step not in ("complete", "world"):
        raise AppError(
            status.HTTP_409_CONFLICT,
            "ONBOARDING_INCOMPLETE",
            f"Finish the '{state.next_step}' step first.",
            details={"next_step": state.next_step},
        )
    if user.onboarding_completed_at is None:
        user.onboarding_completed_at = utcnow()
        audit.record(
            session, "onboarding.completed", actor=user.id, target_type="user", target_id=user.id
        )
    return await onboarding_state(session, user)
