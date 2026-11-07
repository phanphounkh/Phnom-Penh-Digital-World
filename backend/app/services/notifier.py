"""Delivery of one-time verification codes.

No e-mail or SMS provider is integrated yet. Outside production the code is written to the
server log (and, when EXPOSE_DEV_VERIFICATION_CODES=true, returned to the client so the
developer banner can show it). In production, delivery fails loudly until a provider exists.
"""

import logging

from fastapi import status

from app.core.config import settings
from app.core.errors import AppError

logger = logging.getLogger("ppw.notifier")


def mask_destination(channel: str, destination: str) -> str:
    if channel == "email":
        local, _, domain = destination.partition("@")
        return f"{local[:1]}***@{domain}"
    return f"{destination[:4]}•••{destination[-3:]}"


def deliver_verification_code(channel: str, destination: str, code: str) -> None:
    if settings.app_env == "production":
        raise AppError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "DELIVERY_UNAVAILABLE",
            "Verification messages cannot be sent yet. Please try again later.",
        )
    logger.warning(
        "DEV verification code for %s %s: %s (no delivery provider configured)",
        channel,
        mask_destination(channel, destination),
        code,
    )
