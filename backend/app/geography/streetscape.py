"""Street furniture derived from road data, in world coordinates (metres, z = -north).

* Street-name signs stand at real intersections: wherever two differently named roads share
  an OSM node. Each sign has one blade per street, aligned with that street.
* Street lamps are GENERATED. OSM maps no lamps in this area, so they are spaced along major
  roads and promenades. They are decoration and labelled as such (`k: "lamp_gen"`).

Pure functions on shapely geometries, so they can be tested without a database.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge
from shapely.strtree import STRtree

SIGNED_CLASSES = {
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "pedestrian",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
}
LAMP_CLASSES = {
    "trunk": 30.0,
    "primary": 30.0,
    "secondary": 32.0,
    "tertiary": 36.0,
    "pedestrian": 24.0,
}


@dataclass
class NamedLine:
    name: str
    name_en: str | None
    name_km: str | None
    highway: str
    width: float
    line: LineString  # world coordinates


def _direction_at(line: LineString, point: tuple[float, float]) -> tuple[float, float]:
    """Unit direction of the line at one of its vertices."""
    coords = list(line.coords)
    i = min(
        range(len(coords)),
        key=lambda k: (coords[k][0] - point[0]) ** 2 + (coords[k][1] - point[1]) ** 2,
    )
    a = coords[max(0, i - 1)]
    b = coords[min(len(coords) - 1, i + 1)]
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dz) or 1.0
    return dx / length, dz / length


def street_signs(
    roads: list[NamedLine],
    obstacles: STRtree | None = None,
    region: Polygon | None = None,
    merge_within: float = 18.0,
) -> list[dict]:
    """One sign per intersection of two differently named streets."""
    at: dict[tuple[float, float], list[NamedLine]] = defaultdict(list)
    for road in roads:
        if road.highway not in SIGNED_CLASSES:
            continue
        for x, z in road.line.coords:
            at[(round(x, 2), round(z, 2))].append(road)
    signs: list[dict] = []
    placed: list[Point] = []
    for (x, z), here in sorted(at.items()):
        streets: dict[str, NamedLine] = {}
        for road in here:
            streets.setdefault(road.name, road)
        if len(streets) < 2:
            continue
        a, b = sorted(streets.values(), key=lambda r: -r.width)[:2]
        if any(p.distance(Point(x, z)) < merge_within for p in placed):
            continue
        da, db = _direction_at(a.line, (x, z)), _direction_at(b.line, (x, z))
        # Stand on the corner between the two streets, just off the wider carriageway.
        cx, cz = da[0] + db[0], da[1] + db[1]
        norm = math.hypot(cx, cz)
        if norm < 1e-3:
            cx, cz, norm = -da[1], da[0], 1.0
        # Along the bisector, the distance to each street is offset * sin(theta / 2); divide so
        # the post stands 1.6 m beyond the edge of the wider carriageway.
        cos_theta = max(-1.0, min(1.0, da[0] * db[0] + da[1] * db[1]))
        half_angle_sin = max(0.3, math.sqrt((1 - cos_theta) / 2))
        offset = (max(a.width, b.width) / 2 + 1.6) / half_angle_sin
        sx, sz = x + cx / norm * offset, z + cz / norm * offset
        point = Point(sx, sz)
        if region is not None and not region.contains(point):
            continue
        if obstacles is not None and len(obstacles.query(point, predicate="intersects")):
            continue
        placed.append(Point(x, z))
        signs.append(
            {
                "p": [round(sx, 2), round(sz, 2)],
                "blades": [
                    {
                        "en": r.name_en or r.name,
                        "km": r.name_km if r.name_km != (r.name_en or r.name) else None,
                        "a": round(math.atan2(d[0], d[1]), 4),
                    }
                    for r, d in ((a, da), (b, db))
                ],
            }
        )
    return signs


def merge_streets(roads: list[NamedLine]) -> list[NamedLine]:
    """Join OSM ways of the same street and class into continuous lines. OSM splits a street
    at every junction, so spacing furniture per way would leave short blocks empty."""
    groups: dict[tuple[str, str, float], list[NamedLine]] = defaultdict(list)
    for road in roads:
        groups[(road.highway.replace("_link", ""), road.name, road.width)].append(road)
    out: list[NamedLine] = []
    for (highway, _, _), members in groups.items():
        if not members[0].name:  # unnamed ways cannot be identified as one street
            out.extend(members)
            continue
        joined = linemerge([m.line for m in members])
        lines = list(joined.geoms) if hasattr(joined, "geoms") else [joined]
        first = members[0]
        out.extend(
            NamedLine(first.name, first.name_en, first.name_km, highway, first.width, line)
            for line in lines
        )
    return out


def generated_lamps(
    roads: list[NamedLine],
    obstacles: STRtree | None = None,
    region: Polygon | None = None,
    clearance: float = 0.8,
) -> list[tuple[float, float, float]]:
    """Lamp posts along major roads (alternating sides) and promenades. Deterministic.
    Returns (x, z, a) where a is the road direction (yaw, radians) so arms can face the road."""
    lamps: list[tuple[float, float, float]] = []
    for road in merge_streets(roads):
        spacing = LAMP_CLASSES.get(road.highway.replace("_link", ""))
        if spacing is None or road.line.length < spacing:
            continue
        offset = road.width / 2 + 0.7
        steps = int(road.line.length // spacing)
        for k in range(1, steps + 1):
            d = k * spacing - spacing / 2
            p = road.line.interpolate(d)
            ahead = road.line.interpolate(min(road.line.length, d + 0.5))
            behind = road.line.interpolate(max(0.0, d - 0.5))
            dx, dz = ahead.x - behind.x, ahead.y - behind.y
            length = math.hypot(dx, dz) or 1.0
            side = 1 if k % 2 else -1
            nx, nz = -dz / length * side, dx / length * side
            point = Point(p.x + nx * offset, p.y + nz * offset)
            if region is not None and not region.contains(point):
                continue
            if obstacles is not None and len(
                obstacles.query(point, predicate="dwithin", distance=clearance)
            ):
                continue
            lamps.append((round(point.x, 2), round(point.y, 2), round(math.atan2(dx, dz), 3)))
    return lamps


def minimum_rectangle(polygon: Polygon) -> list[float]:
    """[cx, cz, length, width, angle] of the minimum rotated rectangle (angle of the long side,
    radians, measured like Three.js yaw: atan2(dx, dz))."""
    rect = polygon.minimum_rotated_rectangle
    coords = list(rect.exterior.coords)[:4]
    edges = [(coords[i], coords[(i + 1) % 4]) for i in range(2)]
    lengths = [math.dist(a, b) for a, b in edges]
    long_i = 0 if lengths[0] >= lengths[1] else 1
    (ax, az), (bx, bz) = edges[long_i]
    c = rect.centroid
    return [
        round(c.x, 2),
        round(c.y, 2),
        round(lengths[long_i], 2),
        round(lengths[1 - long_i], 2),
        round(math.atan2(bx - ax, bz - az), 4),
    ]
