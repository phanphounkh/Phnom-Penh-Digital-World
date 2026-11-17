"""Simulated deliveries use public world points and server-authoritative driver positions."""

import math
import uuid

from geoalchemy2.shape import to_shape
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, not_found
from app.geography.projection import default_projection
from app.models import (
    DeliveryJob,
    DriverProfile,
    Merchant,
    Order,
    PlayerSpawnPoint,
    RoleName,
    Shop,
    User,
)
from app.utils.time import utcnow

DELIVERY_FEE_MINOR = 150
ACTIVE = ("assigned", "picked_up", "in_transit")


def require_driver(user: User) -> None:
    if not user.has_role(RoleName.DRIVER):
        raise AppError(
            403, "DRIVER_APPROVAL_REQUIRED", "An administrator must approve your driver role."
        )


async def profile(session: AsyncSession, user: User, *, lock: bool = False) -> DriverProfile:
    require_driver(user)
    await session.execute(
        insert(DriverProfile)
        .values(user_id=user.id, online=False, vehicle_kind="motorbike")
        .on_conflict_do_nothing()
    )
    stmt = select(DriverProfile).where(DriverProfile.user_id == user.id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = await session.scalar(stmt)
    assert row is not None
    return row


async def set_online(session: AsyncSession, user: User, online: bool, vehicle: str) -> dict:
    row = await profile(session, user, lock=True)
    row.online, row.vehicle_kind = online, vehicle
    await session.commit()
    return {"online": row.online, "vehicle_kind": row.vehicle_kind}


async def dropoff(session: AsyncSession, spawn_id: uuid.UUID | None):
    point = await session.get(PlayerSpawnPoint, spawn_id) if spawn_id else None
    if point is None or not point.is_active:
        raise conflict("DROPOFF_REQUIRED", "Choose a public virtual drop-off point for delivery.")
    geometry = to_shape(point.location)
    x, z = default_projection().to_world(geometry.y, geometry.x)
    return point, x, z


async def create_job(session: AsyncSession, order: Order, point, x: float, z: float) -> None:
    shop = await session.get(Shop, order.pickup_shop_id) if order.pickup_shop_id else None
    if shop is None or shop.unit.region_id != point.region_id:
        raise conflict(
            "DELIVERY_UNAVAILABLE", "The shop and drop-off must be in the same neighbourhood."
        )
    from app.transport.routing import load_graph

    unit = shop.unit
    # Just outside the door, reachable without driving through the shop floor.
    px = unit.door_x + math.sin(unit.heading) * 3
    pz = unit.door_z + math.cos(unit.heading) * 3
    graph = await load_graph(session, point.region_id)
    if graph.route(px, pz, x, z, "motorbike") is None:
        raise conflict("NO_DELIVERY_ROUTE", "No delivery route reaches this public point.")
    session.add(
        DeliveryJob(
            order_id=order.id,
            status="waiting",
            pickup_x=px,
            pickup_z=pz,
            dropoff_x=x,
            dropoff_z=z,
            dropoff_label=point.name,
        )
    )


async def job_out(session: AsyncSession, job: DeliveryJob, *, tracking: bool = False) -> dict:
    order = await session.get(Order, job.order_id)
    assert order is not None
    from app.multiplayer.hub import hub

    driver = hub.by_user.get(job.driver_id) if job.driver_id else None
    position = None
    if tracking and driver and not driver.closing and job.status in ACTIVE:
        position = {"x": round(driver.x, 1), "z": round(driver.z, 1)}
    return {
        "id": job.id,
        "order_id": job.order_id,
        "number": order.number,
        "status": job.status,
        "order_status": order.status,
        "shop_name": order.merchant.business_name,
        "pickup": {"x": job.pickup_x, "z": job.pickup_z},
        "dropoff": {"x": job.dropoff_x, "z": job.dropoff_z, "label": job.dropoff_label},
        "fee_minor": order.delivery_fee_minor,
        "is_demo": True,
        "driver_online": bool(driver and not driver.closing),
        "position": position,
    }


async def dashboard(session: AsyncSession, user: User) -> dict:
    row = await profile(session, user)
    own = (
        await session.scalars(
            select(DeliveryJob)
            .where(DeliveryJob.driver_id == user.id)
            .order_by(DeliveryJob.created_at.desc())
            .limit(20)
        )
    ).all()
    offers = []
    if row.online:
        offers = (
            await session.scalars(
                select(DeliveryJob)
                .join(Order, Order.id == DeliveryJob.order_id)
                .where(
                    DeliveryJob.status == "waiting",
                    Order.status == "ready_for_pickup",
                    Order.buyer_id != user.id,
                    Order.merchant.has(Merchant.owner_id != user.id),
                )
                .order_by(DeliveryJob.created_at)
                .limit(30)
            )
        ).all()
    result = {
        "online": row.online,
        "vehicle_kind": row.vehicle_kind,
        "jobs": [await job_out(session, job, tracking=True) for job in own],
        "offers": [await job_out(session, job) for job in offers],
    }
    await session.commit()
    return result


async def locked_job(session: AsyncSession, job_id: uuid.UUID) -> tuple[DeliveryJob, Order]:
    order_id = await session.scalar(select(DeliveryJob.order_id).where(DeliveryJob.id == job_id))
    if order_id is None:
        raise not_found("Delivery")
    order = await session.scalar(
        select(Order)
        .where(Order.id == order_id)
        .with_for_update(of=Order)
        .execution_options(populate_existing=True)
    )
    job = await session.scalar(
        select(DeliveryJob)
        .where(DeliveryJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert order is not None and job is not None
    return job, order


async def accept(session: AsyncSession, user: User, job_id: uuid.UUID) -> dict:
    require_driver(user)
    job, order = await locked_job(session, job_id)
    if job.driver_id == user.id and job.status in ACTIVE:
        return await job_out(session, job, tracking=True)
    row = await profile(session, user, lock=True)
    if not row.online:
        raise conflict("GO_ONLINE", "Go online before accepting a job.")
    if job.status != "waiting" or order.status != "ready_for_pickup":
        raise conflict("JOB_UNAVAILABLE", "Another driver accepted this job, or the order changed.")
    if order.buyer_id == user.id or order.merchant.owner_id == user.id:
        raise conflict("OWN_DELIVERY", "You cannot deliver your own order or shop's order.")
    busy = await session.scalar(
        select(DeliveryJob.id).where(
            DeliveryJob.driver_id == user.id, DeliveryJob.status.in_(ACTIVE)
        )
    )
    if busy:
        raise conflict("DRIVER_BUSY", "Complete or release your current job first.")
    from app.marketplace.checkout import _move

    await _move(session, order, "assigned_to_driver", actor=user.id, role="driver")
    job.driver_id, job.status, job.assigned_at = user.id, "assigned", utcnow()
    await session.commit()
    return await job_out(session, job, tracking=True)


def near(user: User, x: float, z: float) -> None:
    from app.multiplayer.hub import hub

    player = hub.by_user.get(user.id)
    if player is None or player.closing:
        raise conflict("ENTER_WORLD", "Enter the city to pick up or deliver this order.")
    if math.hypot(player.x - x, player.z - z) > 15:
        raise conflict("TOO_FAR", "Move within 15 metres of the marked delivery point.")


async def advance(session: AsyncSession, user: User, job_id: uuid.UUID, action: str) -> dict:
    require_driver(user)
    job, order = await locked_job(session, job_id)
    if job.driver_id != user.id:
        raise not_found("Delivery")
    from app.marketplace.checkout import _move

    if action == "release":
        if job.status != "assigned":
            raise conflict("CANNOT_RELEASE", "Only jobs not yet collected can be released.")
        await _move(
            session,
            order,
            "ready_for_pickup",
            actor=user.id,
            role="driver",
            note="Driver released the job",
        )
        job.status, job.driver_id, job.assigned_at = "waiting", None, None
    else:
        transitions = {
            "pickup": ("assigned", "picked_up"),
            "start": ("picked_up", "in_transit"),
            "deliver": ("in_transit", "delivered"),
        }
        before, after = transitions[action]
        if job.status == after:
            return await job_out(session, job, tracking=True)
        if job.status != before:
            raise conflict("INVALID_TRANSITION", "This delivery is not at that step.")
        shop = await session.get(Shop, order.pickup_shop_id)
        from app.multiplayer.hub import hub

        player = hub.by_user.get(user.id)
        if not player or not shop or player.room.region_id != shop.unit.region_id:
            raise conflict("ENTER_WORLD", "Enter this shop's neighbourhood to deliver the order.")
        if action == "pickup":
            near(user, job.pickup_x, job.pickup_z)
        if action == "deliver":
            near(user, job.dropoff_x, job.dropoff_z)
        await _move(session, order, after, actor=user.id, role="driver")
        job.status = after
        if action == "deliver":
            job.delivered_at = utcnow()
            # Completed delivery settles both the merchant and driver's demo earnings.
            await session.flush()
            await _move(session, order, "completed", actor=user.id, role="system")
    await session.commit()
    return await job_out(session, job, tracking=True)


async def tracking(session: AsyncSession, user: User, order_id: uuid.UUID) -> dict:
    order = await session.get(Order, order_id)
    if order is None or not (order.buyer_id == user.id or user.has_role(RoleName.ADMIN)):
        raise not_found("Delivery")
    job = await session.scalar(select(DeliveryJob).where(DeliveryJob.order_id == order_id))
    if job is None:
        raise not_found("Delivery")
    return await job_out(session, job, tracking=True)
