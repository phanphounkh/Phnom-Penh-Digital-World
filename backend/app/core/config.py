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
    osm_data_dir: Path = REPO_ROOT / "tools" / "gis" / "data" / "osm"

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

    @model_validator(mode="after")
    def check_production_safety(self) -> "Settings":
        if self.app_env == "production":
            if self.jwt_secret in WEAK_SECRETS or len(self.jwt_secret) < 32:
                raise ValueError("JWT_SECRET must be a random string of at least 32 characters")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true in production")
            if self.expose_dev_verification_codes:
                raise ValueError("EXPOSE_DEV_VERIFICATION_CODES must be false in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
