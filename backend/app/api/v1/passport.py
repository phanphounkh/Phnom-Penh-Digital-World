"""Merge account keepsakes. These client-earned badges carry no monetary value."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep
from app.models import PlayerPassport, User

STOPS = ("wat-phnom", "canadia-garden", "central-market")
Stamp = Literal["wat-phnom", "canadia-garden", "central-market"]


class PassportProgress(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    stamps: list[Stamp] = Field(default_factory=list, max_length=3)
    delivered: StrictBool = False


router = APIRouter(prefix="/me/passport", tags=["me"])


@router.get("", response_model=PassportProgress)
async def get_passport(user: CurrentUser, session: SessionDep) -> PassportProgress:
    row = await session.get(PlayerPassport, user.id)
    return (
        PassportProgress(stamps=row.stamps, delivered=row.delivered) if row else PassportProgress()
    )


@router.post("", response_model=PassportProgress)
async def merge_passport(
    data: PassportProgress, user: CurrentUser, session: SessionDep
) -> PassportProgress:
    # Lock the existing account even on first save: simultaneous browsers cannot race
    # to create the row or overwrite achievements. Acquiring the lock precedes reading it.
    await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
    row = await session.get(PlayerPassport, user.id)
    if row is None:
        row = PlayerPassport(user_id=user.id, stamps=[], delivered=False)
        session.add(row)
    row.stamps = [stamp for stamp in STOPS if stamp in row.stamps or stamp in data.stamps]
    row.delivered = row.delivered or data.delivered
    await session.commit()
    return PassportProgress(stamps=row.stamps, delivered=row.delivered)
