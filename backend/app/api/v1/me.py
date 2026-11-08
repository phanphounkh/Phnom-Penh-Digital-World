"""The signed-in user's own profile, avatar, roles, private addresses and onboarding."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import ClientIP, CurrentUser, SessionDep
from app.core.errors import not_found
from app.core.rate_limit import rate_limit
from app.models import AvatarCustomization
from app.multiplayer.hub import hub
from app.schemas.auth import MeOut, OnboardingOut
from app.schemas.common import Message
from app.schemas.me import (
    AddressIn,
    AddressOut,
    AvatarIn,
    AvatarOut,
    ProfileUpdate,
    RoleSelection,
    SpawnChoice,
)
from app.services import onboarding

router = APIRouter(prefix="/me", tags=["me"])


@router.patch("/profile", response_model=MeOut)
async def update_profile(data: ProfileUpdate, user: CurrentUser, session: SessionDep) -> MeOut:
    changes = data.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in changes.items():
        setattr(user.profile, field, value.value if hasattr(value, "value") else value)
    await session.commit()
    if "world_visible" in changes:
        hub.update_visibility(user.id, bool(changes["world_visible"]))
    return await onboarding.me_out(session, user)


@router.get("/avatar", response_model=AvatarOut)
async def get_avatar(user: CurrentUser, session: SessionDep) -> AvatarCustomization:
    avatar = await session.get(AvatarCustomization, user.id)
    if avatar is None:
        raise not_found("Avatar")
    return avatar


@router.put("/avatar", response_model=AvatarOut, summary="Create or replace your avatar")
async def put_avatar(data: AvatarIn, user: CurrentUser, session: SessionDep) -> AvatarCustomization:
    avatar = await session.scalar(
        select(AvatarCustomization).where(AvatarCustomization.user_id == user.id)
    )
    if avatar is None:
        avatar = AvatarCustomization(user_id=user.id, model="avatar")
        session.add(avatar)
    for field, value in data.model_dump().items():
        setattr(avatar, field, value)
    await session.commit()
    await session.refresh(avatar)
    return avatar


@router.post("/roles", response_model=MeOut, summary="Choose roles (seller/driver need approval)")
async def choose_roles(data: RoleSelection, user: CurrentUser, session: SessionDep) -> MeOut:
    await onboarding.select_roles(session, user, data)
    await session.commit()
    return await onboarding.me_out(session, user)


@router.get("/addresses", response_model=list[AddressOut], summary="Your private addresses")
async def list_addresses(user: CurrentUser, session: SessionDep) -> list[AddressOut]:
    return await onboarding.list_addresses(session, user.id)


@router.post(
    "/addresses",
    response_model=AddressOut,
    status_code=201,
    dependencies=[Depends(rate_limit("address", 30, 3600))],
    summary="Save a private delivery address (must be inside Phnom Penh)",
)
async def add_address(
    data: AddressIn, user: CurrentUser, session: SessionDep, ip: ClientIP
) -> AddressOut:
    address = await onboarding.add_address(session, user, data, ip)
    await session.commit()
    return address


@router.delete("/addresses/{address_id}", response_model=Message)
async def delete_address(address_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Message:
    await onboarding.delete_address(session, user, address_id)
    await session.commit()
    return Message(message="Address deleted")


@router.put("/spawn", response_model=MeOut, summary="Choose a public spawn area and visibility")
async def choose_spawn(data: SpawnChoice, user: CurrentUser, session: SessionDep) -> MeOut:
    await onboarding.choose_spawn(session, user, data.spawn_point_id, data.world_visible)
    await session.commit()
    return await onboarding.me_out(session, user)


@router.post("/onboarding/complete", response_model=OnboardingOut)
async def complete_onboarding(user: CurrentUser, session: SessionDep) -> OnboardingOut:
    state = await onboarding.complete(session, user)
    await session.commit()
    return state
