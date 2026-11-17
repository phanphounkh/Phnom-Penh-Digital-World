from datetime import timedelta

from sqlalchemy import update

from app.core.database import SessionLocal
from app.models import PasswordReset
from tests.conftest import make_client, register_verified


async def test_reset_token_is_single_use_and_revokes_sessions(client):
    await register_verified(client, "reset_user")
    response = await client.post("/auth/password/request", json={"identifier": "reset_user"})
    assert response.status_code == 200
    token = response.json()["dev_token"]
    old_cookie = client.cookies["ppw_session"]
    async with make_client() as anonymous:
        response = await anonymous.post(
            "/auth/password/reset", json={"token": token, "password": "my-new-safe-password"}
        )
        assert response.status_code == 200, response.text
        assert (await client.get("/auth/me")).status_code == 401
        anonymous.cookies.set("ppw_session", old_cookie)
        assert (await anonymous.get("/auth/me")).status_code == 401
        anonymous.cookies.clear()
        assert (
            await anonymous.post(
                "/auth/password/reset", json={"token": token, "password": "another-safe-password"}
            )
        ).status_code == 400
        assert (
            await anonymous.post(
                "/auth/login", json={"identifier": "reset_user", "password": "my-new-safe-password"}
            )
        ).status_code == 200


async def test_expired_reset_and_unknown_identifier(client):
    await register_verified(client, "expired_reset")
    token = (
        await client.post("/auth/password/request", json={"identifier": "expired_reset"})
    ).json()["dev_token"]
    async with SessionLocal() as session:
        await session.execute(
            update(PasswordReset).values(expires_at=PasswordReset.created_at - timedelta(seconds=1))
        )
        await session.commit()
    response = await client.post(
        "/auth/password/reset", json={"token": token, "password": "my-new-safe-password"}
    )
    assert response.status_code == 400
    response = await client.post("/auth/password/request", json={"identifier": "not_an_account"})
    assert response.status_code == 200 and "dev_token" not in response.json()


async def test_production_delivery_does_not_expose_provider_errors(monkeypatch):
    import smtplib

    import pytest

    from app.core.config import settings
    from app.core.errors import AppError
    from app.services import notifier

    monkeypatch.setattr(settings, "app_env", "production")

    def fail(*args):
        raise smtplib.SMTPException("secret-provider-detail")

    monkeypatch.setattr(notifier, "_send", fail)
    with pytest.raises(AppError) as error:
        await notifier.deliver_message("email", "test@example.com", "secret-code")
    assert error.value.status_code == 503
    assert "secret" not in str(error.value)


async def test_smtp_uses_tls_and_configured_sender(monkeypatch):
    from app.core.config import settings
    from app.services import notifier

    calls = []

    class MailServer:
        def __init__(self, host, port, timeout):
            calls.append((host, port, timeout))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def starttls(self, context):
            calls.append("tls")

        def login(self, username, password):
            calls.append("login")

        def send_message(self, message):
            calls.append((message["From"], message["To"]))

    monkeypatch.setattr(settings, "app_env", "production")
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_from", "accounts@example.com")
    monkeypatch.setattr(settings, "smtp_username", "service")
    monkeypatch.setattr(notifier.smtplib, "SMTP", MailServer)
    await notifier.deliver_verification_code("email", "player@example.com", "123456")
    assert calls == [
        ("smtp.example.com", 587, 10),
        "tls",
        "login",
        ("accounts@example.com", "player@example.com"),
    ]
