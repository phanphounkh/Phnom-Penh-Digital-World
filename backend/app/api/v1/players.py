from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep
from app.core.errors import not_found
from app.models import AvatarCustomization, User
from app.schemas.me import AvatarIn, PublicPlayerOut

router = APIRouter(prefix="/players", tags=["players"])
PUBLIC_BADGES = ("seller", "driver")


@router.get(
    "/{username}",
    response_model=PublicPlayerOut,
    summary="Public player card (no contact details, addresses or locations)",
)
async def player(username: str, viewer: CurrentUser, session: SessionDep) -> PublicPlayerOut:
    user = await session.scalar(select(User).where(User.username == username.lower()))
    # Hidden players are indistinguishable from missing ones, except to themselves.
    if (
        user is None
        or not user.is_active
        or user.onboarding_completed_at is None
        or (not user.profile.world_visible and user.id != viewer.id)
    ):
        raise not_found("Player")
    avatar = await session.get(AvatarCustomization, user.id)
    return PublicPlayerOut(
        username=user.username,
        display_name=user.profile.display_name,
        avatar=AvatarIn.model_validate(avatar, from_attributes=True) if avatar else None,
        badges=[r for r in user.active_roles if r in PUBLIC_BADGES],
        member_since=user.created_at,
    )
