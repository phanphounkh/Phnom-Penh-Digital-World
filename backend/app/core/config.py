"""Application settings loaded from environment variables (and the repo-level `.env`)."""

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent

WEAK_SECRETS = {"", "change-me", "change-me-to-a-long-random-string-of-at-least-32-chars"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Phnom Penh Digital World API"
    app_env: Literal["development", "test", "production"] = "development"

    database_url: str = "postgresql+psycopg://ppw:ppw@localhost:5440/ppw"
    test_database_url: str | None = None
    db_echo: bool = False

    jwt_secret: str = "change-me"  # noqa: S105  (dev default; rejected in production)
    jwt_algorithm: str = "HS256"
    session_ttl_minutes: int = Field(default=60 * 24 * 7, ge=5, le=60 * 24 * 30)

    session_cookie_name: str = "ppw_session"
    csrf_cookie_name: str = "ppw_csrf"
    csrf_header_name: str = "X-CSRF-Token"
    cookie_secure: bool = False

    allowed_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]
    trust_proxy_headers: bool = False

    # Contact verification. No SMS/e-mail provider is integrated yet: codes are logged by the
    # server, and in development they can also be returned to the client (clearly labelled).
    verification_code_ttl_minutes: int = Field(default=15, ge=1, le=60)
    verification_max_attempts: int = Field(default=5, ge=1, le=10)
    verification_resend_seconds: int = Field(default=60, ge=0)
    expose_dev_verification_codes: bool = True

    # Geography / world
    world_region_slug: str = "daun-penh-central"
    world_tick_hz: int = Field(default=10, ge=1, le=60)
    world_room_capacity: int = Field(default=150, ge=2, le=2000)
    world_persist_seconds: int = Field(default=30, ge=1)
    world_resume_minutes: int = Field(default=15, ge=0)
    osm_data_dir: Path = REPO_ROOT / "tools" / "gis" / "data" / "osm"

    # Marketplace (Phase 4). Virtual shop units are claims on a virtual storefront only; they
    # never grant rights to real property. Money is integer minor units (US cents).
    media_root: Path = BACKEND_DIR / "var" / "media"
    claim_term_days: int = Field(default=30, ge=1, le=365)
    claim_pending_days: int = Field(default=14, ge=1, le=90)
    max_units_per_merchant: int = Field(default=3, ge=1, le=50)
    payment_expiry_minutes: int = Field(default=15, ge=1, le=120)
    # Demo checkout: simulated payments with no monetary value, always labelled as such. There
    # is no real payment provider; real money needs a licensed provider and legal advice.
    demo_payments_enabled: bool = True
    # Multiplies every rate limit. Only the isolated E2E stack raises it (many sign-ups from
    # one address); production refuses anything but 1.
    rate_limit_scale: int = Field(default=1, ge=1, le=100)

    timezone: str = "Asia/Phnom_Penh"
    terms_version: str = "2026-11-draft"

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [o.strip().rstrip("/") for o in value.split(",") if o.strip()]
        return value

    @field_validator("osm_data_dir", mode="after")
    @classmethod
    def resolve_data_dir(cls, value: Path) -> Path:
        return value if value.is_absolute() else (REPO_ROOT / value).resolve()

    @field_validator("media_root", mode="after")
    @classmethod
    def resolve_media_root(cls, value: Path) -> Path:
        return value if value.is_absolute() else (BACKEND_DIR / value).resolve()

    @model_validator(mode="after")
    def check_production_safety(self) -> "Settings":
        if self.app_env == "production":
            if self.jwt_secret in WEAK_SECRETS or len(self.jwt_secret) < 32:
                raise ValueError("JWT_SECRET must be a random string of at least 32 characters")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true in production")
            if self.expose_dev_verification_codes:
                raise ValueError("EXPOSE_DEV_VERIFICATION_CODES must be false in production")
            if self.rate_limit_scale != 1:
                raise ValueError("RATE_LIMIT_SCALE must be 1 in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
