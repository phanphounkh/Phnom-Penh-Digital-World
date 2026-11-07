"""Geographic world data imported from OpenStreetMap (WGS84 / EPSG:4326 storage).

Source-of-truth features live in normalised tables with GiST indexes for spatial queries.
`world_chunks.payload` is a derived cache (pre-projected world coordinates) that the 3D client
streams; it is rebuilt by the importer and can always be regenerated from the tables.
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
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base, CreatedAtMixin, TimestampMixin, UUIDPrimaryKey


def _geom(kind: str) -> Any:
    # Spatial indexes are declared explicitly (GiST) so migrations stay explicit.
    return Geometry(kind, srid=4326, spatial_index=False)


class GeographicRegion(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "geographic_regions"
    __table_args__ = (
        CheckConstraint("kind IN ('city','district','neighborhood')", name="kind"),
        Index("ix_geographic_regions_boundary", "boundary", postgresql_using="gist"),
    )

    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    name_km: Mapped[str | None] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(16))
    is_playable: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_service_area: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    boundary: Mapped[Any] = mapped_column(_geom("MULTIPOLYGON"))
    dataset: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")


class OsmFeatureMixin:
    osm_type: Mapped[str] = mapped_column(String(8))
    osm_id: Mapped[int] = mapped_column(BigInteger)
    name: Mapped[str | None] = mapped_column(String(200))
    name_en: Mapped[str | None] = mapped_column(String(200))
    name_km: Mapped[str | None] = mapped_column(String(200))


class Road(OsmFeatureMixin, Base):
    __tablename__ = "roads"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_roads_osm"),
        Index("ix_roads_geom", "geom", postgresql_using="gist"),
        Index("ix_roads_region", "region_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    highway: Mapped[str] = mapped_column(String(32))
    ref: Mapped[str | None] = mapped_column(String(32))
    lanes: Mapped[int | None] = mapped_column(Integer)
    oneway: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    width_m: Mapped[float] = mapped_column(Float)
    width_source: Mapped[str] = mapped_column(String(16))  # osm | lanes | estimated
    surface: Mapped[str | None] = mapped_column(String(32))
    layer: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_bridge: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    geom: Mapped[Any] = mapped_column(_geom("LINESTRING"))


class Building(OsmFeatureMixin, Base):
    __tablename__ = "buildings"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_buildings_osm"),
        Index("ix_buildings_footprint", "footprint", postgresql_using="gist"),
        Index("ix_buildings_region", "region_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    building: Mapped[str] = mapped_column(String(32))
    levels: Mapped[int | None] = mapped_column(Integer)
    height_m: Mapped[float] = mapped_column(Float)
    min_height_m: Mapped[float] = mapped_column(Float, default=0, server_default="0")
    height_source: Mapped[str] = mapped_column(String(16))  # osm | levels | estimated
    colour: Mapped[str | None] = mapped_column(String(16))
    roof_shape: Mapped[str | None] = mapped_column(String(32))
    address: Mapped[str | None] = mapped_column(String(200))
    footprint: Mapped[Any] = mapped_column(_geom("MULTIPOLYGON"))


class LandArea(OsmFeatureMixin, Base):
    """Parks, water, plazas and land use polygons (rendered as ground surfaces)."""

    __tablename__ = "land_areas"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_land_areas_osm"),
        Index("ix_land_areas_geom", "geom", postgresql_using="gist"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(32))  # water | park | grass | plaza | wetland | ...
    geom: Mapped[Any] = mapped_column(_geom("MULTIPOLYGON"))


class Landmark(OsmFeatureMixin, Base):
    """Named points of interest: markets, pagodas, museums, shops, cafés, offices…"""

    __tablename__ = "landmarks"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_landmarks_osm"),
        Index("ix_landmarks_location", "location", postgresql_using="gist"),
        Index(
            "ix_landmarks_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    category: Mapped[str] = mapped_column(String(16))  # amenity | shop | tourism | historic | ...
    subtype: Mapped[str] = mapped_column(String(48))
    importance: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    location: Mapped[Any] = mapped_column(_geom("POINT"))
    building_id: Mapped[int | None] = mapped_column(ForeignKey("buildings.id", ondelete="SET NULL"))


class StreetFeature(Base):
    """Point street furniture: trees, traffic signals, street lamps, crossings."""

    __tablename__ = "street_features"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_street_features_osm"),
        Index("ix_street_features_location", "location", postgresql_using="gist"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    osm_type: Mapped[str] = mapped_column(String(8))
    osm_id: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(24))
    location: Mapped[Any] = mapped_column(_geom("POINT"))


class Place(Base):
    """City-wide search index: khans, neighbourhoods, villages, markets and attractions."""

    __tablename__ = "places"
    __table_args__ = (
        UniqueConstraint("osm_type", "osm_id", name="uq_places_osm"),
        Index("ix_places_location", "location", postgresql_using="gist"),
        Index(
            "ix_places_search_trgm",
            "search_text",
            postgresql_using="gin",
            postgresql_ops={"search_text": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    osm_type: Mapped[str] = mapped_column(String(8))
    osm_id: Mapped[int] = mapped_column(BigInteger)
    name: Mapped[str] = mapped_column(String(200))
    name_en: Mapped[str | None] = mapped_column(String(200))
    name_km: Mapped[str | None] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(32))
    search_text: Mapped[str] = mapped_column(String(700))
    location: Mapped[Any] = mapped_column(_geom("POINT"))


class WorldChunk(TimestampMixin, Base):
    __tablename__ = "world_chunks"
    __table_args__ = (
        UniqueConstraint("ix", "iz", name="uq_world_chunks_ix_iz"),
        Index("ix_world_chunks_bounds", "bounds", postgresql_using="gist"),
    )

    key: Mapped[str] = mapped_column(String(24), primary_key=True)  # "<ix>_<iz>"
    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    ix: Mapped[int] = mapped_column(Integer)
    iz: Mapped[int] = mapped_column(Integer)
    bounds: Mapped[Any] = mapped_column(_geom("POLYGON"))
    building_count: Mapped[int] = mapped_column(Integer, default=0)
    road_count: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    etag: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)


class PlayerSpawnPoint(UUIDPrimaryKey, CreatedAtMixin, Base):
    """Curated PUBLIC places where avatars appear. Never a user's private address."""

    __tablename__ = "player_spawn_points"
    __table_args__ = (
        Index("ix_player_spawn_points_location", "location", postgresql_using="gist"),
    )

    region_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="CASCADE")
    )
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    name_km: Mapped[str | None] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(300))
    location: Mapped[Any] = mapped_column(_geom("POINT"))
    heading_deg: Mapped[float] = mapped_column(Float, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class DatasetImport(UUIDPrimaryKey, Base):
    """One row per importer run: provenance for the data the world is built from."""

    __tablename__ = "dataset_imports"

    region_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("geographic_regions.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(120))
    licence: Mapped[str] = mapped_column(String(120))
    osm_base_timestamp: Mapped[str | None] = mapped_column(String(32))
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
