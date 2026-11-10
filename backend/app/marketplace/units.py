"""Virtual shop units: claimable ground-floor storefronts cut into real OSM buildings.

A unit is a W x D rectangle inside a building footprint whose front edge lies on a wall that
faces a real street. The client opens a doorway in that wall and renders a shop interior in
the rectangle, so players walk from the real street into the shop and see each other inside.

Units are generated from the same pre-projected chunk payloads the client renders, so a
unit's front edge lies exactly (to the centimetre) on a wall the client draws.

What is never generated: units in residential buildings (homes are not storefronts), in
places of worship, schools, hospitals, government, transport and landmark buildings, or on
building parts. Buildings that host a named real business (an OSM shop, amenity, office...)
still get units, but claiming them requires evidence and an administrator's review.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any

from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.geography.projection import WorldProjection
from app.models import GeographicRegion, PropertyClaim, VirtualProperty

logger = logging.getLogger("ppw.units")

UNIT_WIDTH_M = 6.0
UNIT_DEPTH_M = 8.0
UNIT_GAP_M = 1.0  # wall thickness between neighbouring units
MAX_CEILING_M = 3.6
MIN_CEILING_M = 2.8
MAX_UNITS_PER_EDGE = 4
MAX_UNITS_PER_BUILDING = 6
ROAD_SEARCH_M = 30.0
DOOR_WIDTH_M = UNIT_WIDTH_M - 1.0  # shared with the client (door opening, jambs 0.5 m)
DOOR_HEIGHT_M = 2.9
BUSINESS_REACH_M = 12.0  # a named business this close to a unit makes it verification-only

# Building kinds that may host a storefront. Anything residential is excluded on purpose.
STOREFRONT_KINDS = {
    "yes",
    "retail",
    "commercial",
    "shop",
    "kiosk",
    "restaurant",
    "hotel",
    "office",
    "mixed_use",
}
STREET_CLASSES = {
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "unclassified",
    "living_street",
    "pedestrian",
    "service",
}
BUSINESS_CATEGORIES = {"shop", "amenity", "office", "craft", "tourism", "healthcare"}


@dataclass
class UnitSpec:
    unit_key: str
    building_id: int | None
    street_name: str | None
    street_name_km: str | None
    corners: list[list[float]]  # world [x, z]; door edge first (corner 0 -> corner 1)
    door_x: float
    door_z: float
    heading: float
    ceiling_m: float
    requires_verification: bool
    real_business_name: str | None
    width_m: float = UNIT_WIDTH_M
    depth_m: float = UNIT_DEPTH_M
    extra: dict[str, Any] = field(default_factory=dict)


def _r(v: float) -> float:
    return round(v, 2)


def generate_units(payloads: list[dict[str, Any]]) -> list[UnitSpec]:
    """Deterministic unit layout for a region's chunk payloads (world coordinates)."""
    roads: list[tuple[LineString, dict[str, Any]]] = []
    buildings: list[tuple[Polygon, dict[str, Any]]] = []
    businesses: list[tuple[Point, str]] = []
    for payload in payloads:
        for road in payload.get("roads", []):
            if road["cls"].removesuffix("_link") in STREET_CLASSES and len(road["pts"]) > 1:
                roads.append((LineString(road["pts"]), road))
        for b in payload.get("buildings", []):
            for rings in b["polys"]:
                poly = Polygon(rings[0], rings[1:])
                if poly.is_valid and not poly.is_empty:
                    buildings.append((poly, b))
        for lm in payload.get("landmarks", []):
            if lm.get("cat") in BUSINESS_CATEGORIES and lm.get("name"):
                businesses.append((Point(lm["p"]), lm.get("name_en") or lm["name"]))
    road_tree = STRtree([g for g, _ in roads]) if roads else None
    building_tree = STRtree([g for g, _ in buildings]) if buildings else None
    business_tree = STRtree([p for p, _ in businesses]) if businesses else None

    units: list[UnitSpec] = []
    for index, (poly, b) in enumerate(buildings):
        if b["kind"] not in STOREFRONT_KINDS or b.get("model") or b.get("roof"):
            continue
        if b.get("min_h", 0) > 0:
            continue
        ceiling = min(MAX_CEILING_M, b["h"] - 0.4)
        if ceiling < MIN_CEILING_M:
            continue
        # Named real businesses in (or right at) this building. A unit near one is that
        # business's frontage: claiming it needs evidence and review.
        nearby_businesses: list[tuple[Point, str]] = []
        if business_tree is not None:
            nearby_businesses = [
                businesses[int(k)] for k in business_tree.query(poly.buffer(BUSINESS_REACH_M))
            ]
        accepted: list[Polygon] = []
        ring = list(poly.exterior.coords)
        for edge in range(len(ring) - 1):
            if len(accepted) >= MAX_UNITS_PER_BUILDING:
                break
            (ax, az), (bx, bz) = ring[edge], ring[edge + 1]
            length = math.hypot(bx - ax, bz - az)
            if length < UNIT_WIDTH_M + UNIT_GAP_M:
                continue
            ux, uz = (bx - ax) / length, (bz - az) / length
            nx, nz = -uz, ux  # one of the two normals; flip it to point inside
            mx, mz = (ax + bx) / 2, (az + bz) / 2
            if not poly.contains(Point(mx + nx * 0.5, mz + nz * 0.5)):
                nx, nz = -nx, -nz
            street = _street_in_front(road_tree, roads, mx, mz, nx, nz)
            if street is None:
                continue
            slots = min(
                MAX_UNITS_PER_EDGE, int((length - UNIT_GAP_M) // (UNIT_WIDTH_M + UNIT_GAP_M))
            )
            span = slots * (UNIT_WIDTH_M + UNIT_GAP_M) - UNIT_GAP_M
            for slot in range(slots):
                if len(accepted) >= MAX_UNITS_PER_BUILDING:
                    break
                offset = (length - span) / 2 + slot * (UNIT_WIDTH_M + UNIT_GAP_M)
                p0 = (ax + ux * offset, az + uz * offset)
                p1 = (p0[0] + ux * UNIT_WIDTH_M, p0[1] + uz * UNIT_WIDTH_M)
                p2 = (p1[0] + nx * UNIT_DEPTH_M, p1[1] + nz * UNIT_DEPTH_M)
                p3 = (p0[0] + nx * UNIT_DEPTH_M, p0[1] + nz * UNIT_DEPTH_M)
                rect = Polygon([p0, p1, p2, p3])
                if not rect.within(poly.buffer(0.03)):
                    continue
                if any(rect.buffer(UNIT_GAP_M * 0.9).intersects(other) for other in accepted):
                    continue
                if _overlaps_other_building(building_tree, buildings, index, rect):
                    continue
                cx, cz = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
                outside = Point(cx - nx * 1.5, cz - nz * 1.5)
                if _inside_any_building(building_tree, buildings, outside):
                    continue
                business = next(
                    (
                        name
                        for point, name in nearby_businesses
                        if rect.distance(point) <= BUSINESS_REACH_M
                    ),
                    None,
                )
                accepted.append(rect)
                units.append(
                    UnitSpec(
                        unit_key=f"b{b.get('id')}:{edge}:{slot}",
                        building_id=b.get("id"),
                        street_name=street.get("name_en") or street.get("name"),
                        street_name_km=street.get("name_km"),
                        corners=[[_r(x), _r(z)] for x, z in (p0, p1, p2, p3)],
                        door_x=_r(cx),
                        door_z=_r(cz),
                        heading=round(math.atan2(-nx, -nz), 4),
                        ceiling_m=round(ceiling, 2),
                        requires_verification=business is not None,
                        real_business_name=business,
                    )
                )
    return units


def _street_in_front(
    tree: STRtree | None,
    roads: list[tuple[LineString, dict[str, Any]]],
    mx: float,
    mz: float,
    nx: float,
    nz: float,
) -> dict[str, Any] | None:
    """The nearest street within reach in front of the wall (outward normal = -n)."""
    if tree is None:
        return None
    mid = Point(mx, mz)
    best: tuple[float, dict[str, Any]] | None = None
    for k in tree.query(mid.buffer(ROAD_SEARCH_M)):
        line, road = roads[int(k)]
        if road["cls"] == "service" and not road.get("name"):
            continue  # unnamed service ways are alleys and parking aisles, not shopping streets
        d = line.distance(mid)
        if d > ROAD_SEARCH_M:
            continue
        nearest = line.interpolate(line.project(mid))
        vx, vz = nearest.x - mx, nearest.y - mz
        if vx * -nx + vz * -nz < 0.7 * math.hypot(vx, vz):
            continue  # the street is beside or behind this wall, not in front of it
        score = d if road.get("name") else d + 8.0  # prefer a named street in front
        if best is None or score < best[0]:
            best = (score, road)
    return best[1] if best else None


def _overlaps_other_building(
    tree: STRtree | None, buildings: list[tuple[Polygon, dict[str, Any]]], own: int, rect: Polygon
) -> bool:
    if tree is None:
        return False
    inner = rect.buffer(-0.05)
    return any(int(k) != own and buildings[int(k)][0].intersects(inner) for k in tree.query(inner))


def _inside_any_building(
    tree: STRtree | None, buildings: list[tuple[Polygon, dict[str, Any]]], point: Point
) -> bool:
    return tree is not None and any(buildings[int(k)][0].contains(point) for k in tree.query(point))


def region_prefix(slug: str) -> str:
    """'daun-penh-central' -> 'DP'."""
    parts = [p for p in re.split(r"[-_]", slug) if p and p not in {"central", "city"}]
    return "".join(p[0] for p in parts[:2]).upper() or "PP"


async def sync_units(
    session: AsyncSession,
    region: GeographicRegion,
    projection: WorldProjection,
    payloads: list[dict[str, Any]],
) -> dict[str, int]:
    """Upsert generated units by `unit_key`. Codes never change once assigned. Units that no
    longer fit the data are removed, unless someone holds a live claim on them (then they stay,
    with their stored geometry, and are logged for an administrator)."""
    specs = generate_units(payloads)
    existing = {
        u.unit_key: u
        for u in (
            await session.scalars(
                select(VirtualProperty).where(VirtualProperty.region_id == region.id)
            )
        ).all()
    }
    prefix = region_prefix(region.slug)
    numbers = [
        int(u.code.split("-")[-1]) for u in existing.values() if u.code.split("-")[-1].isdigit()
    ]
    next_number = max(numbers, default=0) + 1
    created = updated = 0
    # Deterministic numbering for new units: west to east, north to south.
    for spec in sorted(specs, key=lambda s: (round(s.door_z / 50), s.door_x)):
        lat, lon = projection.to_latlon(spec.door_x, spec.door_z)
        ring = [projection.to_latlon(x, z) for x, z in spec.corners]
        footprint = (
            "SRID=4326;POLYGON(("
            + ",".join(f"{lo:.7f} {la:.7f}" for la, lo in [*ring, ring[0]])
            + "))"
        )
        values = {
            "region_id": region.id,
            "building_id": spec.building_id,
            "street_name": spec.street_name,
            "street_name_km": spec.street_name_km,
            "door_x": spec.door_x,
            "door_z": spec.door_z,
            "heading": spec.heading,
            "width_m": spec.width_m,
            "depth_m": spec.depth_m,
            "ceiling_m": spec.ceiling_m,
            "corners": spec.corners,
            "footprint": footprint,
            "door": f"SRID=4326;POINT({lon:.7f} {lat:.7f})",
            "requires_verification": spec.requires_verification,
            "real_business_name": spec.real_business_name,
            "is_active": True,
        }
        unit = existing.pop(spec.unit_key, None)
        if unit is None:
            session.add(
                VirtualProperty(
                    code=f"{prefix}-{next_number:04d}", unit_key=spec.unit_key, **values
                )
            )
            next_number += 1
            created += 1
        else:
            for key, value in values.items():
                setattr(unit, key, value)
            updated += 1
    stale = list(existing.values())
    kept = 0
    if stale:
        claimed = set(
            (
                await session.scalars(
                    select(PropertyClaim.property_id).where(
                        PropertyClaim.property_id.in_([u.id for u in stale]),
                        PropertyClaim.status.in_(("pending", "approved")),
                    )
                )
            ).all()
        )
        kept = len(claimed)
        for unit in stale:
            if unit.id in claimed:
                logger.warning("Unit %s no longer fits the map data but is claimed", unit.code)
        unclaimed = [u.id for u in stale if u.id not in claimed]
        if unclaimed:
            # Units with history (past claims, ended shops) are deactivated, not deleted.
            await session.execute(
                update(VirtualProperty)
                .where(VirtualProperty.id.in_(unclaimed))
                .values(is_active=False)
            )
    await session.flush()
    # Inactive units that never had any claim can go.
    await session.execute(
        delete(VirtualProperty).where(
            VirtualProperty.region_id == region.id,
            VirtualProperty.is_active.is_(False),
            ~select(PropertyClaim.id)
            .where(PropertyClaim.property_id == VirtualProperty.id)
            .exists(),
        )
    )
    return {
        "shop_units": len(specs),
        "units_created": created,
        "units_updated": updated,
        "units_stale_claimed": kept,
    }
