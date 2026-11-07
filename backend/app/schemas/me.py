import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.models.enums import Language, RoleName
from app.schemas.common import Schema

HEX = re.compile(r"^#[0-9a-f]{6}$")
SKIN_TONES = ("#f1d0b5", "#e0b48f", "#c8946b", "#a8744f", "#7e5236", "#5a3824")
ACCESSORIES = ("cap", "glasses", "backpack", "krama")


def _hex(value: str) -> str:
    value = value.strip().lower()
    if not HEX.match(value):
        raise ValueError("Use a #rrggbb colour")
    return value


class AvatarIn(BaseModel):
    avatar_name: str = Field(min_length=2, max_length=32)
    body: Literal["a", "b"]
    skin_tone: str
    hair_style: Literal["short", "long", "bun", "buzz"]
    hair_color: str
    top_style: Literal["hoodie", "tee"]
    top_color: str
    bottom_style: Literal["trousers", "shorts"]
    bottom_color: str
    shoe_color: str
    accent_color: str
    accessories: list[Literal["cap", "glasses", "backpack", "krama"]] = Field(
        default_factory=list, max_length=3
    )

    @field_validator("skin_tone")
    @classmethod
    def check_skin(cls, v: str) -> str:
        v = _hex(v)
        if v not in SKIN_TONES:
            raise ValueError("Choose one of the offered skin tones")
        return v

    @field_validator("hair_color", "top_color", "bottom_color", "shoe_color", "accent_color")
    @classmethod
    def check_hex(cls, v: str) -> str:
        return _hex(v)

    @field_validator("accessories")
    @classmethod
    def unique(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v):
            raise ValueError("Each accessory can be chosen once")
        return sorted(v)

    @field_validator("avatar_name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Avatar name is too short")
        return v


class AvatarOut(AvatarIn, Schema):
    model: str
    updated_at: datetime

    # Stored values were validated on the way in; don't re-check presets on the way out.
    @field_validator("skin_tone")
    @classmethod
    def check_skin(cls, v: str) -> str:
        return v


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=48)
    preferred_language: Language | None = None
    world_visible: bool | None = None


class RoleSelection(BaseModel):
    """Onboarding role choice. Visitor is always included; seller/driver need approval."""

    roles: list[Literal["visitor", "buyer", "seller", "driver"]] = Field(max_length=4)
    seller_note: str | None = Field(default=None, max_length=500)
    driver_note: str | None = Field(default=None, max_length=500)


class AddressIn(BaseModel):
    label: str = Field(default="Home", min_length=1, max_length=40)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    address_line: str = Field(min_length=3, max_length=200)
    details: str | None = Field(default=None, max_length=500)
    is_default: bool = True


class AddressOut(BaseModel):
    """Private: only ever returned to the address owner."""

    id: uuid.UUID
    label: str
    lat: float
    lon: float
    address_line: str
    details: str | None
    is_default: bool
    created_at: datetime


class SpawnChoice(BaseModel):
    spawn_point_id: uuid.UUID
    world_visible: bool


class PublicPlayerOut(BaseModel):
    """What other players may see. No contact details, addresses or real-world location."""

    username: str
    display_name: str
    avatar: AvatarIn | None
    badges: list[RoleName]
    member_since: datetime
