import uuid
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.deps import AdminUser, CurrentUser, SessionDep
from app.core.rate_limit import rate_limit
from app.delivery import service

router = APIRouter(tags=["simulated delivery"])


class Availability(BaseModel):
    online: bool
    vehicle_kind: Literal["bicycle", "motorbike"] = "motorbike"


class RefundReason(BaseModel):
    reason: str = Field(min_length=10, max_length=300)


@router.post("/admin/deliveries/{job_id}/refund")
async def refund(job_id: uuid.UUID, data: RefundReason, admin: AdminUser, session: SessionDep):
    from app.marketplace.checkout import _move
    from app.services import audit

    _job, order = await service.locked_job(session, job_id)
    await _move(session, order, "refunded", actor=admin.id, role="admin", note=data.reason)
    audit.record(
        session, "delivery.refunded", actor=admin.id, target_type="order", target_id=order.id
    )
    await session.commit()
    return {"message": "Delivery cancelled and demo credits refunded."}


@router.get("/driver")
async def dashboard(user: CurrentUser, session: SessionDep):
    return await service.dashboard(session, user)


@router.put("/driver/availability")
async def availability(data: Availability, user: CurrentUser, session: SessionDep):
    return await service.set_online(session, user, data.online, data.vehicle_kind)


@router.post(
    "/driver/jobs/{job_id}/accept", dependencies=[Depends(rate_limit("delivery-accept", 60, 60))]
)
async def accept(job_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    return await service.accept(session, user, job_id)


@router.post(
    "/driver/jobs/{job_id}/{action}", dependencies=[Depends(rate_limit("delivery-action", 120, 60))]
)
async def advance(
    job_id: uuid.UUID,
    action: Literal["pickup", "start", "deliver", "release"],
    user: CurrentUser,
    session: SessionDep,
):
    return await service.advance(session, user, job_id, action)


@router.get("/orders/{order_id}/delivery")
async def tracking(order_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    return await service.tracking(session, user, order_id)
