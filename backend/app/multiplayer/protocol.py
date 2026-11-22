"""WebSocket protocol (JSON, one object per message, field `t` = type).

Client → server
  {t:"move",  x, z, yaw, s, l?}        own position (world metres), heading (rad), speed (m/s),
                                       storey of the building you are in (0: ground, default)
  {t:"chat",  ch:"nearby"|"world", text}
  {t:"emote", e}                       one of EMOTES
  {t:"travel", spawn}                  fast travel to a public spawn point (slug)
  {t:"invite", to}                     invite an online friend (username) to join you
  {t:"join",  from}                    accept a pending invite (inviter's username)
  {t:"mount", v}                       get on your parked vehicle (id; within 3 m)  [Phase 5]
  {t:"dismount"}                       park it here (kerb, pavement, car park, alley)
  {t:"bset",  b, k, id, on}            you opened/closed a door or window (k:"door"), switched a
                                       light group (k:"light") or an appliance (k:"app") in
                                       building b ("osm:<id>" or a model building's id)
  {t:"bget",  b}                       what players changed in building b (on loading it)
  {t:"ping",  c}                       client timestamp, echoed back

Server → client
  {t:"welcome", you, room, tick, x, z, yaw, online}
  {t:"spawn",  p:{id, u, n, av, x, z, yaw, v?, l?}} a player entered your area (v: riding,
                                                l: storey when not the ground floor)
  {t:"despawn", id, why}                        left your area / disconnected / blocked
  {t:"state",  ts, p:[[id, x, z, yaw, s, l?], ...]} positions of nearby players that changed
                                                (l: storey, only when not 0)
  {t:"chat",   id?, u, n, ch, text, ts}         id = sender's room id when nearby
  {t:"emote",  id, e}
  {t:"teleport", x, z, yaw, why}                authoritative move (travel, join)
  {t:"correct", x, z, why}                      rejected movement; snap back
  {t:"invite", u, n}  {t:"notify", kind, ...}   social events
  {t:"ride", id, v, x?, z?, yaw?}               a player mounted (v:{id,k,c}) or dismounted
                                                (v:null); x/z/yaw only in your own
  {t:"vspawn", v:{id,k,c,x,z,yaw,mine?,name?}}  a parked vehicle in your area (or it changed)
  {t:"vdespawn", id}                            it left your area / was taken / removed
  {t:"bstate", b, s:{"door:front": true, ...}, all?, mine?}  building state: what changed
                                                (from a player near you; mine: your own
                                                change coming back, in the server's order)
                                                or, with all, everything players changed
                                                there (the answer to bget; anything not in
                                                it is in its default state). The room
                                                forgets the changes when its last player
                                                leaves.
  {t:"online", n}  {t:"pong", c, s}  {t:"error", code, message}  {t:"kicked", why}
"""

import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter, model_validator

EMOTES = ("wave", "sampeah", "cheer", "dance")
MAX_MESSAGE_BYTES = 4096
NEARBY_CHAT_RADIUS_M = 40.0
CHAT_MAX_CHARS = 280
# The highest storey a player can be on (generated buildings have two; headroom for more).
MAX_STOREY = 9

Coordinate = Annotated[float, Field(ge=-20000, le=20000, allow_inf_nan=False)]


class Move(BaseModel):
    t: Literal["move"]
    x: Coordinate
    z: Coordinate
    yaw: float = Field(ge=-100, le=100, allow_inf_nan=False)
    s: float = Field(default=0, ge=0, le=100, allow_inf_nan=False)
    l: int = Field(default=0, ge=0, le=MAX_STOREY)  # noqa: E741


BuildingId = Annotated[str, Field(pattern=r"^(osm:\d{1,15}|[a-z0-9][a-z0-9-]{0,39})$")]


class BuildingSet(BaseModel):
    t: Literal["bset"]
    b: BuildingId
    k: Literal["door", "light", "app"]
    id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,48}$")
    on: bool


class BuildingGet(BaseModel):
    t: Literal["bget"]
    b: BuildingId


class Chat(BaseModel):
    t: Literal["chat"]
    ch: Literal["nearby", "world"] = "nearby"
    text: str = Field(min_length=1, max_length=1000)


class Emote(BaseModel):
    t: Literal["emote"]
    e: Literal["wave", "sampeah", "cheer", "dance"]


class Travel(BaseModel):
    """Fast travel to a public spawn area, or to the street in front of a shop."""

    t: Literal["travel"]
    spawn: str | None = Field(default=None, max_length=64)
    shop: uuid.UUID | None = None

    @model_validator(mode="after")
    def one_destination(self) -> "Travel":
        if (self.spawn is None) == (self.shop is None):
            raise ValueError("travel needs exactly one of spawn or shop")
        return self


class Invite(BaseModel):
    t: Literal["invite"]
    to: str = Field(max_length=24)


class Join(BaseModel):
    t: Literal["join"]
    from_: str = Field(alias="from", max_length=24)


class Mount(BaseModel):
    t: Literal["mount"]
    v: uuid.UUID


class Dismount(BaseModel):
    t: Literal["dismount"]


class Ping(BaseModel):
    t: Literal["ping"]
    c: float = Field(allow_inf_nan=False)


ClientMessage = Annotated[
    Move
    | Chat
    | Emote
    | Travel
    | Invite
    | Join
    | Mount
    | Dismount
    | BuildingSet
    | BuildingGet
    | Ping,
    Field(discriminator="t"),
]
client_message = TypeAdapter(ClientMessage)
