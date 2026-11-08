import uuid
from typing import Any

from pydantic import BaseModel

from app.schemas.geo import SpawnPointOut
from app.schemas.me import AvatarIn


class WorldBounds(BaseModel):
    min_x: float
    min_z: float
    max_x: float
    max_z: float


class PlayableRegion(BaseModel):
    slug: str
    name: str
    name_km: str | None
    bbox: list[float]
    world_bounds: WorldBounds
    chunk_keys: list[str]
    dataset: dict[str, Any]


class TerrainFeature(BaseModel):
    """A smooth mound (see app/geography/terrain.py; mirrored in the client)."""

    slug: str
    kind: str
    x: float
    z: float
    height_m: float
    top_radius_m: float
    base_radius_m: float
    source: str


class WorldConfigOut(BaseModel):
    crs: str
    origin: dict[str, float | str]
    origin_easting: float
    origin_northing: float
    chunk_size: float
    axes: str
    attribution: str
    regions: list[PlayableRegion]
    terrain: list[TerrainFeature]


class WorldPlayer(BaseModel):
    id: uuid.UUID
    username: str
    display_name: str
    world_visible: bool
    avatar: AvatarIn


class StartPosition(BaseModel):
    """Where the player enters: their spawn point, or where they left off (recent reconnect)."""

    x: float
    z: float
    yaw: float
    resumed: bool


class WorldBootstrapOut(BaseModel):
    player: WorldPlayer
    spawn: SpawnPointOut
    start: StartPosition
    config: WorldConfigOut
