"""Transport (Phase 5): the garage, routes on the real road graph, road positions."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import text

from app.api.deps import CurrentUser, SessionDep
from app.core.errors import AppError, not_found
from app.core.rate_limit import rate_limit
from app.geography.projection import default_projection
from app.schemas.transport import (
    RoadPositionOut,
    RouteOut,
    TransportInfoOut,
    TravelMode,
    VehicleIn,
    VehicleOut,
    VehiclePatch,
)
from app.transport import routing, vehicles
from app.transport.specs import MODES

router = APIRouter(tags=["transport"])


@router.get("/transport/info", response_model=TransportInfoOut, summary="Travel modes and rules")
async def info() -> TransportInfoOut:
    return TransportInfoOut.model_validate(vehicles.info())


# ── garage ──────────────────────────────────────────────────────────────────────────────
@router.get("/vehicles", response_model=list[VehicleOut], summary="My vehicles")
async def my_vehicles(user: CurrentUser, session: SessionDep) -> list[VehicleOut]:
    return await vehicles.list_vehicles(session, user)


@router.post(
    "/vehicles",
    response_model=VehicleOut,
    status_code=status.HTTP_201_CREATED,
    summary="Take a free starter vehicle (one of each kind); it is parked next to you",
    dependencies=[Depends(rate_limit("vehicles", 10, 3600))],
)
async def create_vehicle(data: VehicleIn, user: CurrentUser, session: SessionDep) -> VehicleOut:
    return await vehicles.create_starter(session, user, data)


@router.patch("/vehicles/{vehicle_id}", response_model=VehicleOut, summary="Rename or repaint")
async def update_vehicle(
    vehicle_id: uuid.UUID, data: VehiclePatch, user: CurrentUser, session: SessionDep
) -> VehicleOut:
    return await vehicles.update_vehicle(session, user, vehicle_id, data)


@router.post(
    "/vehicles/{vehicle_id}/summon",
    response_model=VehicleOut,
    summary="Valet: bring a parked vehicle to the street next to you (once a minute)",
)
async def summon(vehicle_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> VehicleOut:
    return await vehicles.summon(session, user, vehicle_id)


@router.delete(
    "/vehicles/{vehicle_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Give it back"
)
async def delete_vehicle(vehicle_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Response:
    await vehicles.remove(session, user, vehicle_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── roads and routes ────────────────────────────────────────────────────────────────────
Coordinate = Annotated[float, Query(ge=-20000, le=20000, allow_inf_nan=False)]


async def _graph_at(session: SessionDep, x: float, z: float) -> routing.RoadGraph:
    """The road graph of the playable region containing the world point."""
    lat, lon = default_projection().to_latlon(x, z)
    region_id = await session.scalar(
        text("""SELECT id FROM geographic_regions WHERE is_playable
                AND ST_Contains(boundary, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)) LIMIT 1"""),
        {"lat": lat, "lon": lon},
    )
    if region_id is None:
        raise AppError(422, "OUTSIDE_PLAYABLE_AREA", "That point is outside the mapped area.")
    return await routing.load_graph(session, region_id)


@router.get(
    "/routes",
    response_model=RouteOut,
    response_model_by_alias=True,
    summary="Fastest route on the real streets for a travel mode (one-way streets respected)",
    dependencies=[Depends(rate_limit("routes", 120, 60))],
)
async def route(
    session: SessionDep,
    from_x: Coordinate,
    from_z: Coordinate,
    to_x: Coordinate,
    to_z: Coordinate,
    mode: TravelMode = "foot",
) -> RouteOut:
    graph = await _graph_at(session, from_x, from_z)
    found = graph.route(from_x, from_z, to_x, to_z, mode)
    if found is None:
        raise AppError(
            404, "NO_ROUTE", f"No route for {MODES[mode].label.lower()} between those points."
        )
    return RouteOut.model_validate(found)


@router.get(
    "/roads/snap",
    response_model=RoadPositionOut,
    summary="Nearest road position a travel mode may use (world → road position)",
    dependencies=[Depends(rate_limit("routes", 120, 60))],
)
async def snap(
    session: SessionDep, x: Coordinate, z: Coordinate, mode: TravelMode = "foot"
) -> RoadPositionOut:
    graph = await _graph_at(session, x, z)
    found = graph.snap(x, z, MODES[mode].bit, k=1)
    if not found:
        raise not_found("Road")
    return _position(graph, found[0].edge, found[0].along, found[0].distance)


@router.get(
    "/roads/position",
    response_model=RoadPositionOut,
    summary="World position of a road position (edge id + metres along it)",
)
async def position(
    session: SessionDep, edge: int = Query(ge=1), along_m: float = Query(ge=0, le=100000)
) -> RoadPositionOut:
    region_id = await session.scalar(
        text("SELECT region_id FROM road_edges WHERE id = :e"), {"e": edge}
    )
    if region_id is None:
        raise not_found("Road edge")
    graph = await routing.load_graph(session, region_id)
    return _position(graph, graph.by_id[edge], along_m, 0.0)


def _position(
    graph: routing.RoadGraph, index: int, along: float, distance: float
) -> RoadPositionOut:
    e = graph.edges[index]
    along = min(max(along, 0.0), e.length)
    x, z, bearing = graph.point_at(index, along)
    return RoadPositionOut(
        edge_id=e.id,
        road_id=e.road_id,
        along_m=round(along, 2),
        length_m=round(e.length, 2),
        x=round(x, 2),
        z=round(z, 2),
        bearing=round(bearing, 1),
        distance_m=round(distance, 2),
        street=e.street,
        street_km=e.name_km,
        highway=e.highway,
        width_m=e.width,
        modes_forward=e.fwd,
        modes_backward=e.bwd,
        max_speed_kmh=e.max_speed_kmh,
    )
