"""Friends, blocks, mutes, direct messages and reports."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from app.api.deps import ClientIP, CurrentUser, SessionDep
from app.core.rate_limit import rate_limit
from app.multiplayer.hub import hub
from app.schemas.common import Message
from app.services import social

router = APIRouter(prefix="/social", tags=["social"])


class FriendOut(BaseModel):
    username: str
    display_name: str
    status: Literal["accepted", "incoming", "outgoing"]
    online: bool
    since: datetime


class UsernameIn(BaseModel):
    username: str = Field(min_length=3, max_length=24)


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class ConversationOut(BaseModel):
    username: str
    display_name: str
    last: str
    last_at: datetime
    from_me: bool
    unread: int


class DirectMessageOut(BaseModel):
    from_me: bool
    text: str
    at: datetime


class ReportIn(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    reason: Literal["harassment", "hate", "spam", "cheating", "inappropriate_name", "other"]
    details: str | None = Field(default=None, max_length=1000)


class RelationsOut(BaseModel):
    blocked: list[str]
    muted: list[str]


@router.get("/friends", response_model=list[FriendOut])
async def friends(user: CurrentUser, session: SessionDep) -> list[dict]:
    return await social.list_friends(session, user)


@router.post(
    "/friends",
    response_model=Message,
    dependencies=[Depends(rate_limit("friend", 30, 3600))],
    summary="Send a friend request (accepts if they already asked you)",
)
async def add_friend(data: UsernameIn, user: CurrentUser, session: SessionDep) -> Message:
    other = await social.player_by_username(session, data.username)
    outcome = await social.request_friend(session, user, other)
    return Message(message="Friend added" if outcome == "accepted" else "Friend request sent")


@router.post("/friends/{username}/accept", response_model=Message)
async def accept(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.respond(session, user, await social.player_by_username(session, username), True)
    return Message(message="Friend added")


@router.post("/friends/{username}/decline", response_model=Message)
async def decline(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.respond(session, user, await social.player_by_username(session, username), False)
    return Message(message="Request declined")


@router.delete("/friends/{username}", response_model=Message)
async def unfriend(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.remove_friend(session, user, await social.player_by_username(session, username))
    return Message(message="Friend removed")


@router.get("/relations", response_model=RelationsOut, summary="Who you have blocked or muted")
async def relations(user: CurrentUser, session: SessionDep) -> dict:
    return await social.list_blocks_and_mutes(session, user)


@router.post("/blocks/{username}", response_model=Message)
async def block(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.block(session, user, await social.player_by_username(session, username))
    return Message(message="Player blocked")


@router.delete("/blocks/{username}", response_model=Message)
async def unblock(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.unblock(session, user, await social.player_by_username(session, username))
    return Message(message="Player unblocked")


@router.post("/mutes/{username}", response_model=Message)
async def mute(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.mute(session, user, await social.player_by_username(session, username))
    return Message(message="Player muted")


@router.delete("/mutes/{username}", response_model=Message)
async def unmute(username: str, user: CurrentUser, session: SessionDep) -> Message:
    await social.unmute(session, user, await social.player_by_username(session, username))
    return Message(message="Player unmuted")


@router.get("/conversations", response_model=list[ConversationOut])
async def conversations(user: CurrentUser, session: SessionDep) -> list[dict]:
    return await social.conversations(session, user)


@router.get("/messages/{username}", response_model=list[DirectMessageOut])
async def thread(
    username: str,
    user: CurrentUser,
    session: SessionDep,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[dict]:
    return await social.thread(
        session, user, await social.player_by_username(session, username), limit
    )


@router.post(
    "/messages/{username}",
    response_model=DirectMessageOut,
    status_code=201,
    dependencies=[Depends(rate_limit("dm", 60, 60))],
)
async def send(username: str, data: TextIn, user: CurrentUser, session: SessionDep) -> dict:
    other = await social.player_by_username(session, username)
    message = await social.send_direct(session, user, other, data.text)
    return {"from_me": True, "text": message.body, "at": message.created_at}


@router.post(
    "/reports",
    response_model=Message,
    status_code=201,
    dependencies=[Depends(rate_limit("report", 20, 3600))],
)
async def report(data: ReportIn, user: CurrentUser, session: SessionDep, ip: ClientIP) -> Message:
    other = await social.player_by_username(session, data.username)
    await social.report(session, user, other, data.reason, data.details, ip)
    return Message(message="Thank you. A moderator will review this report.")


@router.get("/online", summary="Players currently online and visible (all rooms)")
async def online(_: CurrentUser) -> dict[str, int]:
    return {"online": sum(1 for p in hub.by_user.values() if p.visible)}
