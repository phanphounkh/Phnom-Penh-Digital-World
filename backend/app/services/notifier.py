"""SMTP email and a configurable SMS gateway. Production codes are never logged."""

import asyncio
import json
import logging
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage

from app.core.config import settings
from app.core.errors import AppError

logger = logging.getLogger("ppw.notifier")


def mask_destination(channel: str, destination: str) -> str:
    if channel == "email":
        local, _, domain = destination.partition("@")
        return f"{local[:1]}***@{domain}"
    return f"{destination[:4]}•••{destination[-3:]}"


def capabilities() -> dict[str, bool]:
    dev = settings.app_env != "production"
    return {
        "email": dev or bool(settings.smtp_host and settings.smtp_from),
        "phone": dev or bool(settings.sms_webhook_url),
    }


def _send(channel: str, destination: str, message: str) -> None:
    if channel == "email" and settings.smtp_host and settings.smtp_from:
        mail = EmailMessage()
        mail["From"], mail["To"] = settings.smtp_from, destination
        mail["Subject"] = "Phnom Penh Digital World · Account security"
        mail.set_content(message)
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            if settings.smtp_starttls:
                server.starttls(context=ssl.create_default_context())
            if settings.smtp_username:
                server.login(settings.smtp_username, settings.smtp_password)
            server.send_message(mail)
    elif channel == "phone" and settings.sms_webhook_url:
        if not settings.sms_webhook_url.startswith("https://"):
            raise AppError(503, "DELIVERY_UNAVAILABLE", "The SMS gateway must use HTTPS.")
        request = urllib.request.Request(  # noqa: S310 -- administrator URL, HTTPS enforced above
            settings.sms_webhook_url,
            data=json.dumps({"to": destination, "message": message}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.sms_webhook_token}",
            },
            method="POST",
        )

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise OSError("SMS gateway did not accept the message")
    else:
        raise AppError(
            503, "DELIVERY_UNAVAILABLE", "This verification channel is not configured yet."
        )


async def deliver_message(channel: str, destination: str, message: str) -> None:
    if settings.app_env != "production":
        logger.warning(
            "DEV message for %s %s: %s", channel, mask_destination(channel, destination), message
        )
        return
    try:
        await asyncio.to_thread(_send, channel, destination, message)
    except AppError:
        raise
    except (OSError, smtplib.SMTPException, urllib.error.URLError) as exc:
        logger.error("Account notification failed (%s)", type(exc).__name__)
        raise AppError(
            503, "DELIVERY_UNAVAILABLE", "Could not send the message. Please try again."
        ) from None


async def deliver_verification_code(channel: str, destination: str, code: str) -> None:
    await deliver_message(
        channel, destination, f"Your verification code is {code}. It expires in 15 minutes."
    )
