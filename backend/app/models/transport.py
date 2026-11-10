"""Transport (Phase 5): the routing graph derived from OSM roads, and players' vehicles.

`road_nodes` / `road_edges` are rebuilt by the importer from the same OSM snapshot as
`roads` (like `world_chunks`, they are derived data). Edges keep the OSM way's direction:
`access_fwd` / `access_bwd` are bit masks of the travel modes allowed along and against it
(app/transport/specs.py: foot 1, bicycle 2, motorbike 4, car 8).
"""

import uuid
from datetime import datetime
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base, TimestampMixin, UUIDPrimaryKey

VEHICLE_KIND_CHECK = "kind IN ('bicycle','motorbike')"


class RoadNode(Base):
    """A junction or a dead end of the road graph (an OSM node, or a clipped end)."""

    __tablename__ = "road_nodes"
    __table_args__ = (
        UniqueConstraint("region_id", "node_key", name="uq_road_nodes_region_key"),
        Index("ix_road_nodes_location", "location", postgresql_using="gist"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    # The OSM node id; negative for synthetic ends (where a road leaves the playable area).
    node_key: Mapped[int] = mapped_column(BigInteger)
    x: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    degree: Mapped[int] = mapped_column(SmallInteger)
    is_signal: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    location: Mapped[Any] = mapped_column(Geometry("POINT", srid=4326, spatial_index=False))


class RoadEdge(Base):
    """A stretch of one OSM way between two graph nodes, in the way's direction."""

    __tablename__ = "road_edges"
    __table_args__ = (
        CheckConstraint("length_m > 0", name="length_positive"),
        CheckConstraint(
            "access_fwd BETWEEN 0 AND 15 AND access_bwd BETWEEN 0 AND 15", name="masks"
        ),
        Index("ix_road_edges_geom", "geom", postgresql_using="gist"),
        Index("ix_road_edges_region", "region_id"),
        Index("ix_road_edges_road", "road_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    road_id: Mapped[int] = mapped_column(ForeignKey("roads.id", ondelete="CASCADE"))
    from_node_id: Mapped[int] = mapped_column(ForeignKey("road_nodes.id", ondelete="CASCADE"))
    to_node_id: Mapped[int] = mapped_column(ForeignKey("road_nodes.id", ondelete="CASCADE"))
    length_m: Mapped[float] = mapped_column(Float)
    highway: Mapped[str] = mapped_column(String(32))
    width_m: Mapped[float] = mapped_column(Float)
    access_fwd: Mapped[int] = mapped_column(SmallInteger)
    access_bwd: Mapped[int] = mapped_column(SmallInteger)
    max_speed_kmh: Mapped[int | None] = mapped_column(SmallInteger)  # OSM maxspeed only
    pts: Mapped[list[list[float]]] = mapped_column(JSONB)  # world metres, from → to
    geom: Mapped[Any] = mapped_column(Geometry("LINESTRING", srid=4326, spatial_index=False))


class Vehicle(UUIDPrimaryKey, TimestampMixin, Base):
    """A player's vehicle. Parked vehicles stay where they were left (virtual position)."""

    __tablename__ = "vehicles"
    __table_args__ = (
        CheckConstraint(VEHICLE_KIND_CHECK, name="kind_valid"),
        CheckConstraint("status IN ('parked','in_use')", name="status_valid"),
        CheckConstraint("color ~ '^#[0-9a-f]{6}$'", name="color_hex"),
        # Phase 5 hands out one free starter vehicle of each kind per player.
        UniqueConstraint("owner_id", "kind", name="uq_vehicles_owner_kind"),
        Index("ix_vehicles_region_status", "region_id", "status"),
    )

    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(7))
    # Virtual plate ("DW 3K-0427"): an identifier in this world, never a real registration.
    plate: Mapped[str] = mapped_column(String(12), unique=True)
    status: Mapped[str] = mapped_column(String(12), default="parked", server_default="parked")
    x: Mapped[float] = mapped_column(Float)
    z: Mapped[float] = mapped_column(Float)
    yaw: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    parked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    odometer_m: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
