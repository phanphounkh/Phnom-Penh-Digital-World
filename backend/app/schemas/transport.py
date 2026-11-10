"""Transport API schemas (Phase 5): vehicles, routes, road positions, travel modes."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

VehicleKind = Literal["bicycle", "motorbike"]
TravelMode = Literal["foot", "bicycle", "motorbike"]


class VehicleIn(BaseModel):
    kind: VehicleKind
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    name: str | None = Field(default=None, min_length=1, max_length=40)


class VehiclePatch(BaseModel):
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    name: str | None = Field(default=None, min_length=1, max_length=40)


class VehicleOut(BaseModel):
    id: uuid.UUID
    kind: VehicleKind
    name: str
    color: str
    plate: str
    status: Literal["parked", "in_use"]
    x: float
    z: float
    yaw: float
    street: str | None
    street_km: str | None
    odometer_m: float
    parked_at: datetime | None
    created_at: datetime


class ModeOut(BaseModel):
    mode: TravelMode
    label: str
    label_km: str
    top_speed: float
    cruise_speed: float
    radius: float
    parking_spacing: float


class TransportInfoOut(BaseModel):
    modes: list[ModeOut]
    bits: dict[str, int]
    mount_range_m: float
    ride_margin_client_m: float
    kerb_band_m: float
    pull_over_m: float
    starter_colors: list[str]


class RoadPositionOut(BaseModel):
    """A world position snapped to the road graph (road position ↔ world position)."""

    edge_id: int
    road_id: int
    along_m: float
    length_m: float
    x: float
    z: float
    bearing: float
    distance_m: float
    street: str | None
    street_km: str | None
    highway: str
    width_m: float
    modes_forward: int
    modes_backward: int
    max_speed_kmh: int | None


class RouteEnd(BaseModel):
    x: float
    z: float
    off_road_m: float


class RouteSegment(BaseModel):
    edge: int
    pts: list[list[float]]
    length_m: float
    w: float
    cls: str
    oneway: bool
    street: str | None
    street_km: str | None
    speed_kmh: int | None


class RouteStep(BaseModel):
    type: str
    street: str | None
    street_km: str | None
    bearing: int
    x: float
    z: float
    at_m: float
    distance_m: float


class RouteOut(BaseModel):
    mode: TravelMode
    distance_m: float
    duration_s: int
    from_: RouteEnd = Field(alias="from", serialization_alias="from")
    to: RouteEnd
    points: list[list[float]]
    segments: list[RouteSegment]
    steps: list[RouteStep]

    model_config = {"populate_by_name": True}
