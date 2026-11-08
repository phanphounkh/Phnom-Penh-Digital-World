"""Marketplace request/response models. Money is always integer minor units (US cents)."""

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.models.market import BUSINESS_CATEGORIES, DISPLAY_MODELS, DOCUMENT_KINDS, SHOP_THEMES
from app.schemas.auth import clean_phone
from app.schemas.common import Schema

HEX = re.compile(r"^#[0-9a-f]{6}$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

BusinessCategory = Literal[*BUSINESS_CATEGORIES]  # type: ignore[valid-type]
DisplayModel = Literal[*DISPLAY_MODELS]  # type: ignore[valid-type]
DocumentKind = Literal[*DOCUMENT_KINDS]  # type: ignore[valid-type]
ShopTheme = Literal[*SHOP_THEMES]  # type: ignore[valid-type]


def _text(value: str | None) -> str | None:
    if value is None:
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def _hex(value: str) -> str:
    value = value.strip().lower()
    if not HEX.match(value):
        raise ValueError("Use a #rrggbb colour")
    return value


def check_hours(value: dict[str, Any]) -> dict[str, list[list[str]]]:
    out: dict[str, list[list[str]]] = {}
    for day, spans in value.items():
        if day not in DAYS:
            raise ValueError(f"Unknown day '{day}' (use mon…sun)")
        if not isinstance(spans, list) or len(spans) > 3:
            raise ValueError("Up to 3 opening periods per day")
        clean = []
        for span in spans:
            if not (isinstance(span, list | tuple) and len(span) == 2):
                raise ValueError("Each period is [open, close]")
            start, end = span
            if not (HHMM.match(str(start)) and HHMM.match(str(end))) or start >= end:
                raise ValueError("Use HH:MM, with closing after opening")
            clean.append([start, end])
        out[day] = clean
    return out


# ── Merchants ─────────────────────────────────────────────────────────────────────


class MerchantIn(BaseModel):
    business_name: str = Field(min_length=2, max_length=120)
    business_name_km: str | None = Field(default=None, max_length=120)
    category: BusinessCategory
    description: str | None = Field(default=None, max_length=600)
    contact_phone: str | None = None
    contact_email: EmailStr | None = None
    business_address: str | None = Field(default=None, max_length=300)
    operating_hours: dict[str, Any] = Field(default_factory=dict)

    _clean = field_validator("business_name", "business_name_km", "description", "business_address")(
        classmethod(lambda cls, v: _text(v))
    )

    @field_validator("contact_phone")
    @classmethod
    def phone(cls, v: str | None) -> str | None:
        return clean_phone(v)

    @field_validator("contact_email")
    @classmethod
    def email(cls, v: str | None) -> str | None:
        return v.lower() if v else None

    @field_validator("operating_hours")
    @classmethod
    def hours(cls, v: dict[str, Any]) -> dict[str, Any]:
        return check_hours(v)

    @model_validator(mode="after")
    def contact(self) -> "MerchantIn":
        if not (self.contact_phone or self.contact_email):
            raise ValueError("Give a contact phone or e-mail for customers")
        if not self.business_name or len(self.business_name) < 2:
            raise ValueError("Enter the business name")
        return self


class DocumentOut(Schema):
    id: uuid.UUID
    kind: str
    original_name: str
    content_type: str
    size_bytes: int
    status: str
    created_at: datetime


class MerchantOut(Schema):
    id: uuid.UUID
    business_name: str
    business_name_km: str | None
    category: str
    description: str | None
    contact_phone: str | None
    contact_email: str | None
    business_address: str | None
    operating_hours: dict[str, Any]
    status: str
    decision_reason: str | None
    created_at: datetime
    documents: list[DocumentOut] = []
    seller_role: str | None = None  # active | pending | rejected | None


class AdminMerchantOut(MerchantOut):
    owner_username: str
    owner_display_name: str


class Decision(BaseModel):
    reason: str | None = Field(default=None, max_length=300)


# ── Units, claims, transfers, disputes ────────────────────────────────────────────


class UnitOut(BaseModel):
    code: str
    street_name: str | None
    street_name_km: str | None
    lat: float
    lon: float
    corners_ll: list[list[float]]  # [lat, lon] x4
    width_m: float
    depth_m: float
    requires_verification: bool
    real_business_name: str | None
    status: Literal["available", "claimed", "pending", "inactive"]
    shop_name: str | None = None


class ClaimIn(BaseModel):
    unit_code: str = Field(min_length=3, max_length=16)
    evidence_note: str | None = Field(default=None, max_length=600)
    document_id: uuid.UUID | None = None

    @field_validator("unit_code")
    @classmethod
    def code(cls, v: str) -> str:
        return v.strip().upper()


class ClaimOut(BaseModel):
    id: uuid.UUID
    unit: UnitOut
    status: str
    evidence_note: str | None
    decision_reason: str | None
    created_at: datetime
    decided_at: datetime | None
    starts_at: datetime | None
    expires_at: datetime | None
    ended_at: datetime | None
    shop_id: uuid.UUID | None = None
    merchant_name: str | None = None
    merchant_username: str | None = None
    document: DocumentOut | None = None


class TransferIn(BaseModel):
    to_username: str = Field(min_length=3, max_length=24)


class TransferOut(BaseModel):
    id: uuid.UUID
    unit_code: str
    from_merchant: str
    to_merchant: str
    status: str
    created_at: datetime
    direction: Literal["incoming", "outgoing"]


class DisputeIn(BaseModel):
    unit_code: str = Field(min_length=3, max_length=16)
    reason: str = Field(min_length=20, max_length=1000)
    contact: str | None = Field(default=None, max_length=200)

    @field_validator("unit_code")
    @classmethod
    def code(cls, v: str) -> str:
        return v.strip().upper()


class DisputeOut(BaseModel):
    id: uuid.UUID
    unit_code: str
    real_business_name: str | None
    claim_id: uuid.UUID | None
    claimed_by: str | None
    disputer: str
    reason: str
    contact: str | None
    status: str
    resolution_note: str | None
    created_at: datetime


class DisputeResolution(BaseModel):
    uphold: bool
    note: str | None = Field(default=None, max_length=300)


# ── Shops and catalogue ───────────────────────────────────────────────────────────


class ShopIn(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    name_km: str | None = Field(default=None, max_length=60)
    tagline: str | None = Field(default=None, max_length=80)
    theme: ShopTheme | None = None
    primary_color: str | None = None
    accent_color: str | None = None
    is_open: bool | None = None

    _clean = field_validator("name", "name_km", "tagline")(classmethod(lambda cls, v: _text(v)))

    @field_validator("primary_color", "accent_color")
    @classmethod
    def colour(cls, v: str | None) -> str | None:
        return _hex(v) if v is not None else None


class ShopUnitWorld(BaseModel):
    code: str
    corners: list[list[float]]
    door_x: float
    door_z: float
    heading: float
    width_m: float
    depth_m: float
    ceiling_m: float
    street_name: str | None


class ShopOut(BaseModel):
    id: uuid.UUID
    name: str
    name_km: str | None
    tagline: str | None
    theme: str
    primary_color: str
    accent_color: str
    is_open: bool
    status: str
    merchant_id: uuid.UUID
    merchant_name: str
    owner_username: str
    category: str
    unit: ShopUnitWorld
    operating_hours: dict[str, Any] = {}
    catalog_version: str = ""


class CategoryOut(Schema):
    id: int
    slug: str
    name: str
    name_km: str | None
    policy: str
    policy_note: str | None
    min_age: int | None


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    name_km: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=1000)
    category: str = Field(min_length=2, max_length=32)
    price_minor: int = Field(ge=1, le=1_000_000)
    model: DisplayModel = "box"
    fulfillment: list[Literal["pickup", "delivery"]] = Field(
        default_factory=lambda: ["pickup"], min_length=1, max_length=2
    )
    stock: int = Field(default=0, ge=0, le=100_000)
    visible: bool = True

    _clean = field_validator("name", "name_km", "description")(classmethod(lambda cls, v: _text(v)))

    @field_validator("fulfillment")
    @classmethod
    def unique(cls, v: list[str]) -> list[str]:
        return sorted(set(v))


class ProductPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    name_km: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=1000)
    category: str | None = Field(default=None, min_length=2, max_length=32)
    price_minor: int | None = Field(default=None, ge=1, le=1_000_000)
    model: DisplayModel | None = None
    fulfillment: list[Literal["pickup", "delivery"]] | None = Field(
        default=None, min_length=1, max_length=2
    )
    visible: bool | None = None
    sort_order: int | None = Field(default=None, ge=0, le=999)

    _clean = field_validator("name", "name_km", "description")(classmethod(lambda cls, v: _text(v)))


class StockIn(BaseModel):
    on_hand: int = Field(ge=0, le=100_000)


class ProductOut(BaseModel):
    id: uuid.UUID
    merchant_id: uuid.UUID
    name: str
    name_km: str | None
    description: str | None
    category: str
    category_name: str
    min_age: int | None
    price_minor: int
    currency: str
    image_url: str | None
    model: str
    status: str
    review_note: str | None = None
    fulfillment: list[str]
    stock: int
    in_stock: bool
    sort_order: int


class ShopDetailOut(ShopOut):
    products: list[ProductOut]


class AdminProductOut(ProductOut):
    merchant_name: str


# ── Cart, checkout, payments, orders ──────────────────────────────────────────────


class CartAddIn(BaseModel):
    product_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=20)
    shop_id: uuid.UUID | None = None


class CartQuantityIn(BaseModel):
    quantity: int = Field(ge=1, le=20)


class CartLineOut(BaseModel):
    product_id: uuid.UUID
    name: str
    name_km: str | None
    image_url: str | None
    model: str
    quantity: int
    unit_price_minor: int
    quoted_price_minor: int
    price_changed: bool
    line_total_minor: int
    available: bool
    problem: str | None = None  # unavailable | insufficient_stock | removed
    stock: int
    min_age: int | None
    shop_id: uuid.UUID | None


class CartGroupOut(BaseModel):
    merchant_id: uuid.UUID
    merchant_name: str
    lines: list[CartLineOut]
    subtotal_minor: int


class CartOut(BaseModel):
    groups: list[CartGroupOut]
    item_count: int
    total_minor: int
    currency: str = "USD"
    needs_age_confirmation: bool
    can_checkout: bool


class CheckoutIn(BaseModel):
    expected_total_minor: int = Field(ge=1)
    fulfillment: Literal["pickup"] = "pickup"
    note: str | None = Field(default=None, max_length=300)
    age_confirmed: bool = False

    _clean = field_validator("note")(classmethod(lambda cls, v: _text(v)))


class OrderItemOut(Schema):
    product_id: uuid.UUID | None
    name: str
    name_km: str | None
    unit_price_minor: int
    quantity: int
    line_total_minor: int


class OrderEventOut(Schema):
    from_status: str | None
    to_status: str
    actor_role: str
    note: str | None
    at: datetime


class OrderOut(BaseModel):
    id: uuid.UUID
    number: str
    status: str
    fulfillment: str
    merchant_id: uuid.UUID
    merchant_name: str
    buyer_username: str | None = None
    pickup_shop: str | None = None
    pickup_unit: str | None = None
    subtotal_minor: int
    delivery_fee_minor: int
    total_minor: int
    currency: str
    note: str | None
    cancel_reason: str | None
    payment_intent_id: uuid.UUID
    payment_status: str
    created_at: datetime
    paid_at: datetime | None
    completed_at: datetime | None
    items: list[OrderItemOut]
    events: list[OrderEventOut]
    refunded_minor: int = 0
    allowed: list[str] = []  # statuses the caller may move this order to


class PaymentOut(BaseModel):
    id: uuid.UUID
    status: str
    amount_minor: int
    currency: str
    provider: str
    is_demo: bool = True
    reference: str | None
    expires_at: datetime
    succeeded_at: datetime | None
    orders: list[OrderOut]
    already_confirmed: bool = False


class TransitionIn(BaseModel):
    to: Literal["merchant_accepted", "preparing", "ready_for_pickup", "completed", "refunded"]
    reason: str | None = Field(default=None, max_length=300)


class RevenueDay(BaseModel):
    day: str
    orders: int
    revenue_minor: int


class RevenueOut(BaseModel):
    days: list[RevenueDay]
    total_orders: int
    total_revenue_minor: int
    refunded_minor: int
    open_orders: int
    currency: str = "USD"
    is_demo: bool = True
