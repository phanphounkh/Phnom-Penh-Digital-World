import uuid
from typing import Any

from pydantic import BaseModel


class LatLon(BaseModel):
    lat: float
    lon: float


class WorldPoint(BaseModel):
    x: float
    z: float


class SpawnPointOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    name_km: str | None
    description: str
    lat: float
    lon: float
    x: float
    z: float
    heading_deg: float
    region: str


class SearchResult(BaseModel):
    kind: str  # khan | village | neighbourhood | marketplace | attraction | street | landmark …
    name: str
    name_en: str | None
    name_km: str | None
    lat: float
    lon: float
    in_playable_area: bool
    in_service_area: bool


class ReverseResult(BaseModel):
    lat: float
    lon: float
    street: str | None
    street_km: str | None
    area: str | None
    area_kind: str | None
    in_playable_area: bool
    in_service_area: bool
    world: WorldPoint | None


class NearbyBuilding(BaseModel):
    id: int
    name: str | None
    kind: str
    height_m: float
    height_source: str
    distance_m: float
    lat: float
    lon: float


class RegionOut(BaseModel):
    slug: str
    name: str
    name_km: str | None
    kind: str
    is_playable: bool
    bbox: list[float]  # [south, west, north, east]
    dataset: dict[str, Any]
