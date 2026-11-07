"""Public geographic lookups over the imported OpenStreetMap data (no personal data)."""

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.api.deps import SessionDep
from app.core.rate_limit import rate_limit
from app.schemas.geo import NearbyBuilding, RegionOut, ReverseResult, SearchResult, SpawnPointOut
from app.services import geo

router = APIRouter(prefix="/geo", tags=["geography"])
_limited = [Depends(rate_limit("geo", 120, 60))]

Lat = Query(ge=11.0, le=12.2, description="Latitude (WGS84)")
Lon = Query(ge=104.3, le=105.5, description="Longitude (WGS84)")


@router.get("/regions", response_model=list[RegionOut])
async def regions(session: SessionDep) -> list[RegionOut]:
    return await geo.regions(session)


@router.get("/service-area", summary="Phnom Penh boundary (GeoJSON, simplified)")
async def service_area(session: SessionDep) -> dict[str, Any]:
    return await geo.service_area_geojson(session)


@router.get("/spawn-points", response_model=list[SpawnPointOut])
async def spawn_points(session: SessionDep) -> list[SpawnPointOut]:
    return await geo.spawn_points(session)


@router.get(
    "/search",
    response_model=list[SearchResult],
    dependencies=_limited,
    summary="Search khans, neighbourhoods, markets, streets and landmarks",
)
async def search(
    session: SessionDep,
    q: str = Query(min_length=2, max_length=80),
    limit: int = Query(default=8, ge=1, le=20),
) -> list[SearchResult]:
    return await geo.search(session, q, limit)


@router.get(
    "/reverse",
    response_model=ReverseResult,
    dependencies=_limited,
    summary="Nearest street and area for a coordinate",
)
async def reverse(session: SessionDep, lat: float = Lat, lon: float = Lon) -> ReverseResult:
    return await geo.reverse(session, lat, lon)


@router.get("/buildings/nearby", response_model=list[NearbyBuilding], dependencies=_limited)
async def nearby_buildings(
    session: SessionDep,
    lat: float = Lat,
    lon: float = Lon,
    radius_m: float = Query(default=100, gt=0, le=500),
    limit: int = Query(default=25, ge=1, le=100),
) -> list[NearbyBuilding]:
    return await geo.nearby_buildings(session, lat, lon, radius_m, limit)
