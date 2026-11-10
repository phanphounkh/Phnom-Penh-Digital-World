"""Players' vehicles: the garage (starter vehicles, paint, name), placement and valet.

Phase 5 has no money, so every player may take one free starter vehicle of each kind. A new
vehicle is parked at the nearest legal spot next to its owner (their live position in the
world, else their spawn area). Riding and parking happen over the world socket (hub.py);
this module only changes vehicles that are parked.
"""

from __future__ import annotations

import random
import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, not_found
from app.core.rate_limit import limiter
from app.models import Vehicle
from app.models.identity import User
from app.multiplayer.hub import hub
from app.schemas.transport import VehicleIn, VehicleOut, VehiclePatch
from app.services import geo
from app.transport import routing
from app.transport.parking import ParkedVehicle
from app.transport.specs import MODES, SUMMON_COOLDOWN_S
from app.utils.time import utcnow

STARTER_COLORS = ["#c4552f", "#2f7d6d", "#e8a33d", "#3d6fb6", "#1d2422", "#f6f1e6", "#6b4fa0"]
DEFAULT_NAMES = {"bicycle": "My bicycle", "motorbike": "My motorbike"}
PLACE_RADIUS_M = 25.0
_PLATE_LETTERS = "ABCDEFGHKLMNPRSTUVXYZ"


def new_plate(rng: random.Random | None = None) -> str:
    """A virtual plate, `DW 3K-0427` ("Digital World"): not a real registration format."""
    r = rng or random.SystemRandom()
    return f"DW {r.randint(1, 9)}{r.choice(_PLATE_LETTERS)}-{r.randint(0, 9999):04d}"


async def _region_of(session: AsyncSession, user: User) -> tuple[uuid.UUID, float, float]:
    """The owner's region and where they are: live position if in the world, else spawn."""
    player = hub.by_user.get(user.id)
    if player is not None:
        return player.room.region_id, player.x, player.z
    spawn = await geo.spawn_point(session, user.profile.spawn_point_id) if user.profile else None
    if spawn is None:
        raise conflict("ONBOARDING_INCOMPLETE", "Choose a spawn area first.")
    region_id = await session.scalar(
        text("SELECT id FROM geographic_regions WHERE slug = :s"), {"s": spawn.region}
    )
    return region_id, spawn.x, spawn.z


async def _place(
    session: AsyncSession, region_id: uuid.UUID, kind: str, x: float, z: float, exclude: str | None
) -> tuple[float, float]:
    world = await hub.region_world(region_id)
    spot = hub.parking_spot(world, kind, x, z, PLACE_RADIUS_M, exclude)
    if spot is None:
        # Standing far from a street (a park, a temple ground): use the nearest road.
        graph = await routing.load_graph(session, region_id)
        for snap in graph.snap(x, z, MODES[kind].bit):
            spot = hub.parking_spot(world, kind, snap.x, snap.z, 12.0, exclude)
            if spot is not None:
                break
    if spot is None:
        raise conflict("NO_PARKING_NEARBY", "There is no street nearby to leave a vehicle on.")
    return spot


async def _streets(
    session: AsyncSession, region_id: uuid.UUID, rows: list[Vehicle]
) -> dict[uuid.UUID, tuple[str | None, str | None]]:
    if not rows:
        return {}
    graph = await routing.load_graph(session, region_id)
    out: dict[uuid.UUID, tuple[str | None, str | None]] = {}
    for v in rows:
        snaps = graph.snap(v.x, v.z, MODES[v.kind].bit, k=1)
        e = graph.edges[snaps[0].edge] if snaps and snaps[0].distance < 40 else None
        out[v.id] = (e.street, e.name_km) if e else (None, None)
    return out


def _out(v: Vehicle, street: tuple[str | None, str | None]) -> VehicleOut:
    live = hub.riding_vehicle(v.owner_id)
    riding = live is not None and live.id == str(v.id)
    return VehicleOut(
        id=v.id,
        kind=v.kind,  # type: ignore[arg-type]
        name=v.name,
        color=v.color,
        plate=v.plate,
        status="in_use" if riding else "parked",
        x=round(live.x if riding and live else v.x, 2),
        z=round(live.z if riding and live else v.z, 2),
        yaw=v.yaw,
        street=street[0],
        street_km=street[1],
        odometer_m=round(live.odometer_m if riding and live else v.odometer_m),
        parked_at=v.parked_at,
        created_at=v.created_at,
    )


async def list_vehicles(session: AsyncSession, user: User) -> list[VehicleOut]:
    rows = list(
        (
            await session.scalars(
                select(Vehicle).where(Vehicle.owner_id == user.id).order_by(Vehicle.created_at)
            )
        ).all()
    )
    out: list[VehicleOut] = []
    for region_id in {v.region_id for v in rows}:
        mine = [v for v in rows if v.region_id == region_id]
        streets = await _streets(session, region_id, mine)
        out.extend(_out(v, streets[v.id]) for v in mine)
    return sorted(out, key=lambda v: v.created_at)


async def _owned(session: AsyncSession, user: User, vehicle_id: uuid.UUID) -> Vehicle:
    vehicle = await session.get(Vehicle, vehicle_id)
    if vehicle is None or vehicle.owner_id != user.id:
        raise not_found("Vehicle")
    return vehicle


def _not_riding(user: User, vehicle: Vehicle) -> None:
    live = hub.riding_vehicle(user.id)
    if live is not None and live.id == str(vehicle.id):
        raise conflict("VEHICLE_IN_USE", "Park the vehicle first.")


def _parked_card(vehicle: Vehicle, visible: bool) -> ParkedVehicle:
    return ParkedVehicle(
        id=str(vehicle.id),
        owner_id=vehicle.owner_id,
        kind=vehicle.kind,
        color=vehicle.color,
        name=vehicle.name,
        x=vehicle.x,
        z=vehicle.z,
        yaw=vehicle.yaw,
        owner_visible=visible,
        odometer_m=vehicle.odometer_m,
    )


async def create_starter(session: AsyncSession, user: User, data: VehicleIn) -> VehicleOut:
    if user.onboarding_completed_at is None:
        raise conflict("ONBOARDING_INCOMPLETE", "Finish setting up your account first.")
    exists = await session.scalar(
        select(Vehicle.id).where(Vehicle.owner_id == user.id, Vehicle.kind == data.kind)
    )
    if exists is not None:
        raise conflict("VEHICLE_EXISTS", f"You already have a {MODES[data.kind].label.lower()}.")
    region_id, x, z = await _region_of(session, user)
    sx, sz = await _place(session, region_id, data.kind, x, z, None)
    player = hub.by_user.get(user.id)
    world = await hub.region_world(region_id)
    yaw = hub.parking_heading(world, data.kind, sx, sz, player.yaw if player else 0.0)
    vehicle = Vehicle(
        owner_id=user.id,
        region_id=region_id,
        kind=data.kind,
        name=data.name or DEFAULT_NAMES[data.kind],
        color=(data.color or random.SystemRandom().choice(STARTER_COLORS)).lower(),
        plate=new_plate(),
        status="parked",
        x=round(sx, 2),
        z=round(sz, 2),
        yaw=round(yaw, 3),
        parked_at=utcnow(),
    )
    for _ in range(5):  # plates are random; retry on the (unlikely) collision
        session.add(vehicle)
        try:
            await session.commit()
            break
        except IntegrityError as exc:
            await session.rollback()
            if "uq_vehicles_owner_kind" in str(exc.orig):
                raise conflict(
                    "VEHICLE_EXISTS", f"You already have a {MODES[data.kind].label.lower()}."
                ) from exc
            vehicle.plate = new_plate()
    else:  # pragma: no cover
        raise AppError(503, "TRY_AGAIN", "Please try again.")
    await session.refresh(vehicle)
    visible = bool(user.profile and user.profile.world_visible)
    hub.vehicle_added(region_id, _parked_card(vehicle, visible))
    return await _with_street(session, vehicle)


async def _with_street(session: AsyncSession, vehicle: Vehicle) -> VehicleOut:
    streets = await _streets(session, vehicle.region_id, [vehicle])
    return _out(vehicle, streets[vehicle.id])


async def update_vehicle(
    session: AsyncSession, user: User, vehicle_id: uuid.UUID, data: VehiclePatch
) -> VehicleOut:
    vehicle = await _owned(session, user, vehicle_id)
    if data.name is not None:
        vehicle.name = data.name.strip() or vehicle.name
    if data.color is not None:
        vehicle.color = data.color.lower()
    await session.commit()
    hub.vehicle_restyled(vehicle.region_id, str(vehicle.id), vehicle.name, vehicle.color)
    return await _with_street(session, vehicle)


async def summon(session: AsyncSession, user: User, vehicle_id: uuid.UUID) -> VehicleOut:
    """Valet: bring a parked vehicle to the nearest legal spot next to its owner (once a
    minute per vehicle). The owner must be in the world, on foot."""
    vehicle = await _owned(session, user, vehicle_id)
    _not_riding(user, vehicle)
    player = hub.by_user.get(user.id)
    if player is None:
        raise conflict("NOT_IN_WORLD", "Enter the world to bring your vehicle to you.")
    if player.riding is not None:
        raise conflict("VEHICLE_IN_USE", "Park the vehicle you are riding first.")
    if player.room.region_id != vehicle.region_id:
        raise conflict("OTHER_REGION", "That vehicle is parked in another part of the city.")
    wait = limiter.hit(f"summon:{vehicle.id}", 1, SUMMON_COOLDOWN_S)
    if wait is not None:
        raise AppError(
            429,
            "RATE_LIMITED",
            f"The valet is on the way. Try again in {wait} s.",
            headers={"Retry-After": str(wait)},
        )
    sx, sz = await _place(
        session, vehicle.region_id, vehicle.kind, player.x, player.z, str(vehicle.id)
    )
    world = await hub.region_world(vehicle.region_id)
    heading = hub.parking_heading(world, vehicle.kind, sx, sz, player.yaw)
    vehicle.x, vehicle.z, vehicle.yaw = round(sx, 2), round(sz, 2), round(heading, 3)
    vehicle.parked_at = utcnow()
    await session.commit()
    visible = bool(user.profile and user.profile.world_visible)
    hub.vehicle_added(vehicle.region_id, _parked_card(vehicle, visible))
    return await _with_street(session, vehicle)


async def remove(session: AsyncSession, user: User, vehicle_id: uuid.UUID) -> None:
    vehicle = await _owned(session, user, vehicle_id)
    _not_riding(user, vehicle)
    region_id, vid = vehicle.region_id, str(vehicle.id)
    await session.delete(vehicle)
    await session.commit()
    hub.vehicle_removed(region_id, vid)


def info() -> dict[str, Any]:
    from app.transport.specs import as_fixture

    fixture = as_fixture()
    return {
        "modes": [
            {
                "mode": m.mode,
                "label": m.label,
                "label_km": m.label_km,
                "top_speed": m.top_speed,
                "cruise_speed": m.cruise_speed,
                "radius": m.radius,
                "parking_spacing": m.parking_spacing,
            }
            for m in MODES.values()
        ],
        "bits": fixture["bits"],
        "mount_range_m": fixture["mount_range_m"],
        "ride_margin_client_m": fixture["ride_margin_client_m"],
        "kerb_band_m": fixture["kerb_band_m"],
        "pull_over_m": fixture["pull_over_m"],
        "starter_colors": STARTER_COLORS,
    }
