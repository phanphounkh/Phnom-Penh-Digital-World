import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog


def record(
    session: AsyncSession,
    action: str,
    *,
    actor: uuid.UUID | None = None,
    target_type: str | None = None,
    target_id: object = None,
    ip: str | None = None,
    **data: Any,
) -> None:
    """Queue an audit entry in the caller's transaction (committed with the change itself)."""
    session.add(
        AuditLog(
            actor_user_id=actor,
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else None,
            ip_address=ip,
            data=data,
        )
    )
