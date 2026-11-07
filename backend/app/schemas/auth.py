import re
import uuid
from datetime import datetime
from typing import Literal

import email_validator
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.models.enums import ContactChannel, Language
from app.utils.text import normalize_phone

# Development accounts use internal addresses such as admin@ppw.local.
if "local" in email_validator.SPECIAL_USE_DOMAIN_NAMES:
    email_validator.SPECIAL_USE_DOMAIN_NAMES.remove("local")

USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,24}$")
RESERVED_USERNAMES = {
    "admin",
    "administrator",
    "root",
    "system",
    "support",
    "moderator",
    "staff",
    "official",
    "ppw",
    "phnompenh",
    "help",
    "security",
    "api",
    "null",
    "undefined",
}


def clean_username(value: str) -> str:
    value = value.strip().lower()
    if not USERNAME_RE.match(value):
        raise ValueError("Use 3–24 letters, numbers, dots or underscores")
    if value.strip("._") != value or ".." in value:
        raise ValueError("Dots and underscores cannot start, end or repeat")
    if value in RESERVED_USERNAMES:
        raise ValueError("This username is reserved")
    return value


def clean_phone(value: str | None) -> str | None:
    if not value or not value.strip():
        return None
    phone = normalize_phone(value)
    if phone.startswith("0"):
        phone = "+855" + phone[1:]  # Cambodian national format, e.g. 012 345 678
    elif not phone.startswith("+"):
        phone = "+" + phone
    if not 9 <= len(phone) - 1 <= 15:
        raise ValueError("Enter a valid phone number")
    return phone


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=32)
    password: str = Field(min_length=10, max_length=128)
    display_name: str = Field(min_length=2, max_length=48)
    preferred_language: Language = Language.EN
    accept_terms: Literal[True]
    accept_privacy: Literal[True]

    @field_validator("username")
    @classmethod
    def check_username(cls, v: str) -> str:
        return clean_username(v)

    @field_validator("phone")
    @classmethod
    def check_phone(cls, v: str | None) -> str | None:
        return clean_phone(v)

    @field_validator("email")
    @classmethod
    def lower_email(cls, v: str | None) -> str | None:
        return v.lower() if v else None

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if len(v) < 2:
            raise ValueError("Display name is too short")
        return v

    @model_validator(mode="after")
    def check(self) -> "RegisterRequest":
        if not self.email and not self.phone:
            raise ValueError("Provide an email address or a phone number")
        if self.password.lower() == self.username or len(set(self.password)) < 4:
            raise ValueError("Choose a less guessable password")
        return self


class LoginRequest(BaseModel):
    # Username, email or phone number.
    identifier: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class VerificationSendRequest(BaseModel):
    channel: ContactChannel | None = None


class VerificationConfirmRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


class VerificationOut(BaseModel):
    channel: ContactChannel
    destination: str  # masked, e.g. s***@example.com
    expires_at: datetime
    resend_after_seconds: int
    # Only present in development when no delivery provider is configured.
    dev_code: str | None = None


class RoleOut(BaseModel):
    role: str
    status: str
    requested_at: datetime
    decided_at: datetime | None
    decision_reason: str | None


class OnboardingOut(BaseModel):
    verified: bool
    avatar: bool
    roles: bool
    location: bool
    needs_address: bool
    completed: bool
    next_step: Literal["verify", "avatar", "role", "location", "complete", "world"]


class MeOut(BaseModel):
    id: uuid.UUID
    username: str
    display_name: str
    email: str | None
    phone: str | None
    email_verified: bool
    phone_verified: bool
    preferred_language: Language
    world_visible: bool | None
    roles: list[RoleOut]
    active_roles: list[str]
    onboarding: OnboardingOut
    created_at: datetime


class SessionOut(BaseModel):
    user: MeOut
    csrf_token: str
    expires_at: datetime
    verification: VerificationOut | None = None


class AuthSessionOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    user_agent: str | None
    current: bool
