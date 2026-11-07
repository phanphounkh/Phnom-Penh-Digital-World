"""Spatial queries: search, reverse lookup, nearby buildings, spawn points, regions."""

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.geography.projection import default_projection
from app.schemas.geo import (
    NearbyBuilding,
    RegionOut,
    ReverseResult,
    SearchResult,
    SpawnPointOut,
    WorldPoint,
)
from app.utils.text import escape_like

_POINT = "ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)"
_FLAGS = """
  EXISTS (SELECT 1 FROM geographic_regions r WHERE r.is_playable AND ST_Contains(r.boundary, {g}))
    AS in_playable_area,
  EXISTS (SELECT 1 FROM geographic_regions r
          WHERE r.is_service_area AND ST_Contains(r.boundary, {g}))
    AS in_service_area
"""


async def search(session: AsyncSession, query: str, limit: int = 10) -> list[SearchResult]:
    q = " ".join(query.split()).lower()
    if len(q) < 2:
        return []
    pattern = f"%{escape_like(q)}%"
    sql = text(f"""
      WITH hits AS (
        SELECT kind, name, name_en, name_km, location AS g,
               similarity(search_text, :q) + CASE WHEN search_text LIKE :p THEN 0.5 ELSE 0 END
               + CASE kind WHEN 'khan' THEN 0.3 WHEN 'marketplace' THEN 0.2 ELSE 0 END AS score
        FROM places
        WHERE search_text LIKE :p OR search_text % :q
        UNION ALL
        SELECT 'street', name, max(name_en), max(name_km),
               ST_ClosestPoint(ST_Collect(geom), ST_Centroid(ST_Collect(geom))),
               0.6 + similarity(lower(name), :q)
        FROM roads
        WHERE name IS NOT NULL AND (lower(name) LIKE :p OR lower(coalesce(name_en, '')) LIKE :p
                                    OR coalesce(name_km, '') LIKE :p)
        GROUP BY name
        UNION ALL
        SELECT 'landmark', name, name_en, name_km, location,
               0.4 + importance * 0.1 + similarity(lower(name), :q)
        FROM landmarks
        WHERE lower(name) LIKE :p OR lower(coalesce(name_en, '')) LIKE :p
              OR coalesce(name_km, '') LIKE :p
      )
      SELECT kind, name, name_en, name_km, ST_Y(g) AS lat, ST_X(g) AS lon,
             {_FLAGS.format(g="g")}
      FROM hits ORDER BY score DESC, name LIMIT :limit
    """)
    rows = await session.execute(sql, {"q": q, "p": pattern, "limit": limit})
    return [SearchResult.model_validate(dict(r._mapping)) for r in rows]


async def reverse(session: AsyncSession, lat: float, lon: float) -> ReverseResult:
    row = (
        await session.execute(
            text(f"""
      SELECT
        (SELECT json_build_object('name', coalesce(name_en, name), 'name_km', name_km) FROM roads
          WHERE name IS NOT NULL AND ST_DWithin(geom::geography, {_POINT}::geography, 80)
          ORDER BY geom <-> {_POINT} LIMIT 1) AS street,
        (SELECT json_build_object('name', coalesce(name_en, name), 'kind', kind) FROM places
          WHERE kind IN ('neighbourhood','village','quarter','suburb','khan','sangkat')
          ORDER BY location <-> {_POINT} LIMIT 1) AS area,
        {_FLAGS.format(g=_POINT)}
    """),
            {"lat": lat, "lon": lon},
        )
    ).one()
    street: dict[str, Any] | None = row.street
    area: dict[str, Any] | None = row.area
    world = None
    if row.in_playable_area:
        x, z = default_projection().to_world(lat, lon)
        world = WorldPoint(x=round(x, 2), z=round(z, 2))
    return ReverseResult(
        lat=lat,
        lon=lon,
        street=street["name"] if street else None,
        street_km=street["name_km"] if street else None,
        area=area["name"] if area else None,
        area_kind=area["kind"] if area else None,
        in_playable_area=row.in_playable_area,
        in_service_area=row.in_service_area,
        world=world,
    )


async def nearby_buildings(
    session: AsyncSession, lat: float, lon: float, radius_m: float, limit: int = 25
) -> list[NearbyBuilding]:
    rows = await session.execute(
        text(f"""
      SELECT id, coalesce(name_en, name) AS name, building AS kind, height_m, height_source,
             ST_Distance(footprint::geography, {_POINT}::geography) AS distance_m,
             ST_Y(ST_PointOnSurface(footprint)) AS lat, ST_X(ST_PointOnSurface(footprint)) AS lon
      FROM buildings
      WHERE ST_DWithin(footprint::geography, {_POINT}::geography, :r)
      ORDER BY distance_m LIMIT :limit
    """),
        {"lat": lat, "lon": lon, "r": radius_m, "limit": limit},
    )
    return [NearbyBuilding.model_validate(dict(r._mapping)) for r in rows]


def _spawn_out(row: Any) -> SpawnPointOut:
    x, z = default_projection().to_world(row.lat, row.lon)
    return SpawnPointOut(
        id=row.id,
        slug=row.slug,
        name=row.name,
        name_km=row.name_km,
        description=row.description,
        lat=row.lat,
        lon=row.lon,
        x=round(x, 2),
        z=round(z, 2),
        heading_deg=row.heading_deg,
        region=row.region,
    )


_SPAWN_SQL = """
  SELECT s.id, s.slug, s.name, s.name_km, s.description, s.heading_deg,
         ST_Y(s.location) AS lat, ST_X(s.location) AS lon, r.slug AS region
  FROM player_spawn_points s JOIN geographic_regions r ON r.id = s.region_id
  WHERE s.is_active
"""


async def spawn_points(session: AsyncSession) -> list[SpawnPointOut]:
    rows = await session.execute(text(_SPAWN_SQL + " ORDER BY s.sort_order, s.name"))
    return [_spawn_out(r) for r in rows]


async def spawn_point(session: AsyncSession, spawn_id: Any) -> SpawnPointOut | None:
    row = (await session.execute(text(_SPAWN_SQL + " AND s.id = :id"), {"id": spawn_id})).first()
    return _spawn_out(row) if row else None


async def regions(session: AsyncSession, playable_only: bool = False) -> list[RegionOut]:
    rows = await session.execute(
        text("""
      SELECT slug, name, name_km, kind, is_playable, dataset,
             ST_YMin(boundary) s, ST_XMin(boundary) w, ST_YMax(boundary) n, ST_XMax(boundary) e
      FROM geographic_regions WHERE (:all OR is_playable) ORDER BY kind, name
    """),
        {"all": not playable_only},
    )
    return [
        RegionOut(
            slug=r.slug,
            name=r.name,
            name_km=r.name_km,
            kind=r.kind,
            is_playable=r.is_playable,
            bbox=[r.s, r.w, r.n, r.e],
            dataset=r.dataset,
        )
        for r in rows
    ]


async def service_area_geojson(session: AsyncSession) -> dict[str, Any]:
    geometry = await session.scalar(
        text("""
      SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(boundary, 0.0005), 5)::json
      FROM geographic_regions WHERE is_service_area LIMIT 1
    """)
    )
    return {"type": "Feature", "properties": {"name": "Phnom Penh"}, "geometry": geometry}
