"""Import OSM snapshots into PostGIS and build the streamed world chunks.

    snapshot JSON ──parse──▶ features (lon/lat) ──upsert──▶ roads / buildings / … (EPSG:4326)
                                      └──project + clip──▶ world_chunks.payload (world metres)

OSM-derived rows are upserted on (osm_type, osm_id) so database ids stay stable across
re-imports (future virtual-property claims can reference buildings safely). Rows that vanish
from the snapshot are deleted. Regions and spawn points are upserted by slug, never deleted,
because user profiles reference them.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from geoalchemy2.shape import from_shape
from shapely.geometry import Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree
from sqlalchemy import delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.geography import osm
from app.geography.projection import WorldProjection, chunk_key, default_projection
from app.geography.regions import NEIGHBORHOODS, PHNOM_PENH_FALLBACK_BBOX, SPAWN_POINTS
from app.models import (
    Building,
    DatasetImport,
    GeographicRegion,
    LandArea,
    Landmark,
    Place,
    PlayerSpawnPoint,
    Road,
    StreetFeature,
    WorldChunk,
)

logger = logging.getLogger("ppw.importer")
LICENCE = "ODbL 1.0 — © OpenStreetMap contributors"
CITY_SLUG = "phnom-penh"
BATCH = 400


@dataclass
class Snapshot:
    elements: list[dict[str, Any]]
    meta: dict[str, Any]


def load_snapshot(data_dir: Path, name: str) -> Snapshot | None:
    path = data_dir / f"{name}.json"
    if not path.exists():
        return None
    manifest_path = data_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    data = json.loads(path.read_text())
    meta = manifest.get(name, {})
    meta.setdefault("osm_base_timestamp", data.get("osm3s", {}).get("timestamp_osm_base"))
    return Snapshot(data.get("elements", []), meta)


def ewkt(geom: BaseGeometry) -> Any:
    return from_shape(geom, srid=4326)


def bbox_polygon(bbox: tuple[float, float, float, float]) -> Polygon:
    s, w, n, e = bbox
    return box(w, s, e, n)


def _r(v: float) -> float:
    return round(v, 2)


def _ring(coords: Any) -> list[list[float]]:
    pts = [[_r(x), _r(z)] for x, z in list(coords)[:-1]]
    return pts


def _polygons(geom: BaseGeometry) -> list[Polygon]:
    if isinstance(geom, Polygon):
        return [geom] if not geom.is_empty else []
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon) and not g.is_empty]


def _lines(geom: BaseGeometry) -> list[list[list[float]]]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [[[_r(x), _r(z)] for x, z in geom.coords]]
    out: list[list[list[float]]] = []
    for g in getattr(geom, "geoms", []):
        out.extend(_lines(g))
    return [line for line in out if len(line) >= 2]


async def _upsert(
    session: AsyncSession, model: Any, rows: list[dict[str, Any]], conflict: list[str]
) -> None:
    for start in range(0, len(rows), BATCH):
        stmt = insert(model).values(rows[start : start + BATCH])
        update = {c: stmt.excluded[c] for c in rows[0] if c not in conflict}
        await session.execute(stmt.on_conflict_do_update(index_elements=conflict, set_=update))


async def _prune(
    session: AsyncSession, model: Any, region_id: Any, keep: set[tuple[str, int]]
) -> int:
    existing = await session.execute(
        select(model.id, model.osm_type, model.osm_id).where(model.region_id == region_id)
    )
    stale = [row.id for row in existing if (row.osm_type, row.osm_id) not in keep]
    for start in range(0, len(stale), 1000):
        await session.execute(delete(model).where(model.id.in_(stale[start : start + 1000])))
    return len(stale)


async def upsert_region(session: AsyncSession, **values: Any) -> GeographicRegion:
    stmt = insert(GeographicRegion).values(**values)
    stmt = stmt.on_conflict_do_update(
        index_elements=["slug"], set_={k: stmt.excluded[k] for k in values if k != "slug"}
    )
    await session.execute(stmt)
    return (
        await session.execute(
            select(GeographicRegion).where(GeographicRegion.slug == values["slug"])
        )
    ).scalar_one()


async def import_city(session: AsyncSession, data_dir: Path) -> dict[str, Any]:
    boundary_snapshot = load_snapshot(data_dir, "city-boundary")
    boundary = osm.boundary_multipolygon(boundary_snapshot.elements) if boundary_snapshot else None
    source = "osm-relation"
    if boundary is None:
        boundary = osm.as_multipolygon(bbox_polygon(PHNOM_PENH_FALLBACK_BBOX))
        source = "fallback-bbox"
    await upsert_region(
        session,
        slug=CITY_SLUG,
        name="Phnom Penh",
        name_km="ភ្នំពេញ",
        kind="city",
        is_playable=False,
        is_service_area=True,
        boundary=ewkt(boundary),
        dataset={
            "boundary_source": source,
            "osm_base_timestamp": boundary_snapshot.meta.get("osm_base_timestamp")
            if boundary_snapshot
            else None,
            "licence": LICENCE,
        },
    )
    places_snapshot = load_snapshot(data_dir, "city-places")
    rows = []
    seen: set[tuple[str, int]] = set()
    for element in places_snapshot.elements if places_snapshot else []:
        place = osm.place_from(element)
        if place is None or (place.osm_type, place.osm_id) in seen:
            continue
        seen.add((place.osm_type, place.osm_id))
        search = " ".join(p for p in (place.name, place.name_en, place.name_km, place.kind) if p)
        rows.append(
            {
                "osm_type": place.osm_type,
                "osm_id": place.osm_id,
                "name": place.name[:200],
                "name_en": place.name_en,
                "name_km": place.name_km,
                "kind": place.kind,
                "search_text": search.lower()[:700],
                "location": ewkt(place.geom),
            }
        )
    if rows:
        await _upsert(session, Place, rows, ["osm_type", "osm_id"])
    return {"boundary": source, "places": len(rows)}


def find_open_ground(
    target: Point,
    obstacles: STRtree,
    region: Polygon,
    clearance: float = 14.0,
    search: float = 160.0,
    step: float = 3.0,
) -> Point:
    """Nearest point to `target` (world metres) that is at least `clearance` metres from every
    obstacle (building footprints, water) and inside `region`. Searches outward in rings."""

    def clear(p: Point) -> bool:
        if not region.contains(p):
            return False
        return len(obstacles.query(p, predicate="dwithin", distance=clearance)) == 0

    if clear(target):
        return target
    rings = int(search / step)
    for ring in range(1, rings + 1):
        radius = ring * step
        count = max(8, int(2 * math.pi * radius / step))
        candidates = [
            Point(
                target.x + radius * math.cos(2 * math.pi * k / count),
                target.y + radius * math.sin(2 * math.pi * k / count),
            )
            for k in range(count)
        ]
        open_points = [p for p in candidates if clear(p)]
        if open_points:
            return min(open_points, key=lambda p: p.distance(target))
    return target


def facing(from_x: float, from_z: float, to_x: float, to_z: float, default: float) -> float:
    """Compass heading (0 = north) from one world point towards another."""
    dx, dz = to_x - from_x, to_z - from_z
    if math.hypot(dx, dz) < 1:
        return default
    return round((math.degrees(math.atan2(dx, -dz)) + 360) % 360, 1)


def build_chunk_payloads(
    projection: WorldProjection,
    region_world: Polygon,
    parsed: osm.ParsedArea,
    building_ids: dict[tuple[str, int], int],
    road_ids: dict[tuple[str, int], int],
) -> dict[tuple[int, int], dict[str, Any]]:
    min_x, min_z, max_x, max_z = region_world.bounds
    ix0, iz0 = projection.chunk_of(min_x, min_z)
    ix1, iz1 = projection.chunk_of(max_x, max_z)
    chunks: dict[tuple[int, int], dict[str, Any]] = {}
    for ix in range(ix0, ix1 + 1):
        for iz in range(iz0, iz1 + 1):
            cell = box(*projection.chunk_bounds(ix, iz)).intersection(region_world)
            if cell.is_empty:
                continue
            chunks[(ix, iz)] = {
                "key": chunk_key(ix, iz),
                "ix": ix,
                "iz": iz,
                "size": projection.chunk_size,
                "roads": [],
                "buildings": [],
                "areas": [],
                "landmarks": [],
                "features": [],
                "_cell": cell,
            }

    def owner(point: Point) -> dict[str, Any] | None:
        if not region_world.contains(point):
            return None
        return chunks.get(projection.chunk_of(point.x, point.y))

    for b in parsed.buildings:
        world = projection.geometry_to_world(b.geom)
        chunk = owner(world.representative_point())
        if chunk is None:
            continue
        chunk["buildings"].append(
            {
                "id": building_ids.get((b.osm_type, b.osm_id)),
                "name": b.name,
                "name_km": b.name_km,
                "kind": b.building,
                "h": b.height_m,
                "min_h": b.min_height_m,
                "hs": b.height_source,
                "colour": b.colour,
                "polys": [
                    [_ring(p.exterior.coords), *[_ring(i.coords) for i in p.interiors]]
                    for p in _polygons(world)
                ],
            }
        )

    for road in parsed.roads:
        world = projection.geometry_to_world(road.geom)
        for chunk in chunks.values():
            clipped = world.intersection(chunk["_cell"])
            for line in _lines(clipped):
                chunk["roads"].append(
                    {
                        "id": road_ids.get(("way", road.osm_id)),
                        "name": road.name,
                        "name_en": road.name_en,
                        "name_km": road.name_km,
                        "cls": road.highway,
                        "w": road.width_m,
                        "oneway": road.oneway,
                        "bridge": road.is_bridge,
                        "layer": road.layer,
                        "pts": line,
                    }
                )

    for area in parsed.areas:
        world = projection.geometry_to_world(area.geom)
        for chunk in chunks.values():
            clipped = world.intersection(chunk["_cell"])
            polys = _polygons(clipped)
            if polys:
                chunk["areas"].append(
                    {
                        "kind": area.kind,
                        "name": area.name,
                        "polys": [
                            [_ring(p.exterior.coords), *[_ring(i.coords) for i in p.interiors]]
                            for p in polys
                        ],
                    }
                )

    for lm in parsed.landmarks:
        x, z = projection.to_world(lm.geom.y, lm.geom.x)
        chunk = owner(Point(x, z))
        if chunk is not None:
            chunk["landmarks"].append(
                {
                    "name": lm.name,
                    "name_en": lm.name_en,
                    "name_km": lm.name_km,
                    "cat": lm.category,
                    "sub": lm.subtype,
                    "imp": lm.importance,
                    "p": [_r(x), _r(z)],
                }
            )

    for f in parsed.street_features:
        x, z = projection.to_world(f.geom.y, f.geom.x)
        chunk = owner(Point(x, z))
        if chunk is not None:
            chunk["features"].append({"k": f.kind, "p": [_r(x), _r(z)]})

    for chunk in chunks.values():
        chunk.pop("_cell")
        # Most important landmarks first (the client labels the top few).
        chunk["landmarks"].sort(key=lambda lm: -lm["imp"])
    return chunks


async def import_neighborhood(
    session: AsyncSession,
    data_dir: Path,
    slug: str,
    projection: WorldProjection | None = None,
) -> dict[str, Any]:
    projection = projection or default_projection()
    hood = NEIGHBORHOODS[slug]
    snapshot = load_snapshot(data_dir, f"neighborhood-{slug}")
    if snapshot is None:
        raise FileNotFoundError(f"No OSM snapshot for {slug} in {data_dir}")
    region_ll = bbox_polygon(hood["bbox"])
    region = await upsert_region(
        session,
        slug=slug,
        name=hood["name"],
        name_km=hood.get("name_km"),
        kind="neighborhood",
        is_playable=True,
        is_service_area=False,
        boundary=ewkt(osm.as_multipolygon(region_ll)),
        dataset={
            "source": "OpenStreetMap via Overpass API",
            "licence": LICENCE,
            "osm_base_timestamp": snapshot.meta.get("osm_base_timestamp"),
            "fetched_at": snapshot.meta.get("fetched_at"),
            "bbox": list(hood["bbox"]),
        },
    )

    parsed = osm.parse_area(snapshot.elements)
    # Keep features that belong to the region; clip lines/areas to it.
    parsed.roads = [r for r in parsed.roads if r.geom.intersects(region_ll)]
    parsed.buildings = [
        b for b in parsed.buildings if region_ll.contains(b.geom.representative_point())
    ]
    parsed.areas = [a for a in parsed.areas if a.geom.intersects(region_ll)]
    for area in parsed.areas:
        area.geom = osm.as_multipolygon(area.geom.intersection(region_ll)) or area.geom
    parsed.landmarks = [lm for lm in parsed.landmarks if region_ll.contains(lm.geom)]
    parsed.street_features = [f for f in parsed.street_features if region_ll.contains(f.geom)]

    def base(f: Any) -> dict[str, Any]:
        return {
            "region_id": region.id,
            "osm_type": f.osm_type,
            "osm_id": f.osm_id,
            "name": (f.name or None) and f.name[:200],
            "name_en": f.name_en,
            "name_km": f.name_km,
        }

    stats: dict[str, Any] = {}
    road_rows = [
        {
            **base(r),
            "highway": r.highway,
            "ref": r.ref,
            "lanes": r.lanes,
            "oneway": r.oneway,
            "width_m": r.width_m,
            "width_source": r.width_source,
            "surface": r.surface,
            "layer": r.layer,
            "is_bridge": r.is_bridge,
            "geom": ewkt(r.geom),
        }
        for r in parsed.roads
    ]
    building_rows = [
        {
            **base(b),
            "building": b.building[:32],
            "levels": b.levels,
            "height_m": b.height_m,
            "min_height_m": b.min_height_m,
            "height_source": b.height_source,
            "colour": (b.colour or None) and b.colour[:16],
            "roof_shape": b.roof_shape,
            "address": b.address,
            "footprint": ewkt(b.geom),
        }
        for b in parsed.buildings
    ]
    area_rows = [{**base(a), "kind": a.kind, "geom": ewkt(a.geom)} for a in parsed.areas]
    landmark_rows = [
        {
            **base(lm),
            "category": lm.category,
            "subtype": lm.subtype,
            "importance": lm.importance,
            "location": ewkt(lm.geom),
        }
        for lm in parsed.landmarks
    ]
    feature_rows = [
        {
            "region_id": region.id,
            "osm_type": f.osm_type,
            "osm_id": f.osm_id,
            "kind": f.kind,
            "location": ewkt(f.geom),
        }
        for f in parsed.street_features
    ]

    for model, rows, key in (
        (Road, road_rows, "roads"),
        (Building, building_rows, "buildings"),
        (LandArea, area_rows, "areas"),
        (Landmark, landmark_rows, "landmarks"),
        (StreetFeature, feature_rows, "street_features"),
    ):
        # Deduplicate (a relation member may repeat) — the last occurrence wins.
        unique = {(row["osm_type"], row["osm_id"]): row for row in rows}
        if unique:
            await _upsert(session, model, list(unique.values()), ["osm_type", "osm_id"])
        stats[key] = len(unique)
        stats[f"{key}_pruned"] = await _prune(session, model, region.id, set(unique))

    # Link landmarks to the building that contains them.
    await session.execute(
        text("""
        UPDATE landmarks l SET building_id = b.id
        FROM buildings b
        WHERE l.region_id = :rid AND b.region_id = :rid AND ST_Contains(b.footprint, l.location)
    """),
        {"rid": region.id},
    )

    building_ids = {
        (row.osm_type, row.osm_id): row.id
        for row in await session.execute(
            select(Building.id, Building.osm_type, Building.osm_id).where(
                Building.region_id == region.id
            )
        )
    }
    road_ids = {
        (row.osm_type, row.osm_id): row.id
        for row in await session.execute(
            select(Road.id, Road.osm_type, Road.osm_id).where(Road.region_id == region.id)
        )
    }

    region_world = projection.geometry_to_world(region_ll)
    chunks = build_chunk_payloads(projection, region_world, parsed, building_ids, road_ids)
    chunk_rows = []
    for (ix, iz), payload in chunks.items():
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        min_x, min_z, max_x, max_z = projection.chunk_bounds(ix, iz)
        corners = [
            projection.to_latlon(x, z)
            for x, z in ((min_x, min_z), (max_x, min_z), (max_x, max_z), (min_x, max_z))
        ]
        chunk_rows.append(
            {
                "key": payload["key"],
                "region_id": region.id,
                "ix": ix,
                "iz": iz,
                "bounds": ewkt(Polygon([(lon, lat) for lat, lon in corners])),
                "building_count": len(payload["buildings"]),
                "road_count": len(payload["roads"]),
                "version": 1,
                "etag": hashlib.sha256(body.encode()).hexdigest()[:32],
                "payload": payload,
            }
        )
    await session.execute(delete(WorldChunk).where(WorldChunk.region_id == region.id))
    for start in range(0, len(chunk_rows), 50):
        await session.execute(insert(WorldChunk).values(chunk_rows[start : start + 50]))
    stats["chunks"] = len(chunk_rows)

    # Spawn points: nearest open public ground to each landmark, facing it; upsert by slug.
    obstacles = STRtree(
        [p for b in parsed.buildings for p in _polygons(projection.geometry_to_world(b.geom))]
        + [
            p
            for a in parsed.areas
            if a.kind == "water"
            for p in _polygons(projection.geometry_to_world(a.geom))
        ]
    )
    region_inner = region_world.buffer(-10)
    spawn_rows = []
    for order, sp in enumerate(SPAWN_POINTS):
        tx, tz = projection.to_world(sp["lat"], sp["lon"])
        safe = find_open_ground(Point(tx, tz), obstacles, region_inner)
        lat, lon = projection.to_latlon(safe.x, safe.y)
        if not region_ll.contains(Point(lon, lat)):
            logger.warning("Spawn point %s is outside the region; skipped", sp["slug"])
            continue
        heading = facing(safe.x, safe.y, tx, tz, sp["heading_deg"])
        spawn_rows.append(
            {
                "region_id": region.id,
                "slug": sp["slug"],
                "name": sp["name"],
                "name_km": sp.get("name_km"),
                "description": sp["description"],
                "location": ewkt(Point(lon, lat)),
                "heading_deg": heading,
                "is_active": True,
                "sort_order": order,
            }
        )
    if spawn_rows:
        stmt = insert(PlayerSpawnPoint).values(spawn_rows)
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["slug"],
                set_={k: stmt.excluded[k] for k in spawn_rows[0] if k != "slug"},
            )
        )
    stats["spawn_points"] = len(spawn_rows)

    session.add(
        DatasetImport(
            region_id=region.id,
            source="OpenStreetMap via Overpass API",
            licence=LICENCE,
            osm_base_timestamp=snapshot.meta.get("osm_base_timestamp"),
            stats=stats,
        )
    )
    return stats


async def import_all(
    session: AsyncSession, data_dir: Path, slugs: list[str] | None = None
) -> dict[str, Any]:
    result: dict[str, Any] = {"city": await import_city(session, data_dir)}
    for slug in slugs or list(NEIGHBORHOODS):
        result[slug] = await import_neighborhood(session, data_dir, slug)
    await session.commit()
    return result
