"""Phnom Penh Digital World API entry point (modular monolith)."""

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import engine
from app.core.errors import error_body, register_error_handlers
from app.core.security import tokens_match
from app.marketplace import sweeper

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("ppw")

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Endpoints that establish or end a session. They are still protected by the Origin check.
CSRF_EXEMPT_PATHS = {"/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/logout"}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if settings.expose_dev_verification_codes:
        logger.warning("DEV MODE: verification codes are returned to clients. Never in production.")
    async with sweeper.running():
        yield
    await engine.dispose()


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description=(
        "API for **Phnom Penh Digital World**, a multiplayer 3D city built on OpenStreetMap "
        "data.\n\n"
        "* Browser sessions use an HTTP-only `ppw_session` cookie bound to a revocable "
        "server-side session. State-changing requests must echo the `ppw_csrf` cookie in the "
        "`X-CSRF-Token` header.\n"
        "* Geographic coordinates are WGS84; world coordinates are metres on UTM 48N "
        "(EPSG:32648) relative to the origin in `/world/config` (x east, z = -north).\n"
        "* Private delivery addresses are only ever returned to their owner.\n"
        "* Map data © OpenStreetMap contributors (ODbL)."
    ),
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

register_error_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", settings.csrf_header_name, "Idempotency-Key"],
)


@app.middleware("http")
async def csrf_protection(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    if request.method in UNSAFE_METHODS and request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin is not None and origin.rstrip("/") not in settings.allowed_origins:
            return JSONResponse(
                error_body("CSRF_FAILED", "Cross-origin request blocked."), status_code=403
            )
        has_session = settings.session_cookie_name in request.cookies
        if has_session and request.url.path not in CSRF_EXEMPT_PATHS:
            header = request.headers.get(settings.csrf_header_name)
            cookie = request.cookies.get(settings.csrf_cookie_name)
            if not tokens_match(header, cookie):
                return JSONResponse(
                    error_body("CSRF_FAILED", "Missing or invalid CSRF token. Please reload."),
                    status_code=403,
                )
    return await call_next(request)


@app.middleware("http")
async def security_headers(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


app.include_router(api_router)
