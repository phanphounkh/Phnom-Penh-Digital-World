"""The road network: who may use each OSM way (and in which direction), and the routing graph.

Pure functions (no database), so they are tested in isolation:

* `access_masks(road)` turns the highway class and OSM access tags (`access`, `vehicle`,
  `motor_vehicle`, `motorcycle`, `bicycle`, `foot`, `oneway`, `oneway:bicycle`, `junction`)
  into two bit masks of travel modes: allowed along the way's direction and against it.
* `build_graph(roads, …)` splits OSM ways at shared nodes (junctions) into edges between
  graph nodes, in world metres, clipped to the playable area.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, Polygon

from app.geography.osm import RoadFeature
from app.geography.projection import WorldProjection
from app.transport.specs import ALL_MODES, BICYCLE, CAR, FOOT, MOTORBIKE, VEHICLE_MODES

MOTOR_CLASSES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
}
# Default modes per highway class when no access tag says otherwise.
CLASS_MODES = {
    **{c: ALL_MODES for c in MOTOR_CLASSES},
    "motorway": MOTORBIKE | CAR,
    "motorway_link": MOTORBIKE | CAR,
    "pedestrian": FOOT | BICYCLE,
    "footway": FOOT | BICYCLE,
    "path": FOOT | BICYCLE,
    "cycleway": FOOT | BICYCLE,
    "steps": FOOT,
}
# Classes where parking is not allowed in the middle of the carriageway (through roads).
THROUGH_CLASSES = MOTOR_CLASSES - {"service", "track", "living_street"}

ALLOW = {"yes", "designated", "permissive", "destination", "customers", "delivery", "official"}
DENY = {"no", "private", "dismount", "use_sidepath", "discouraged"}
# Most general first: later (more specific) tags override earlier ones.
TAG_MODES = (
    ("access", ALL_MODES),
    ("vehicle", VEHICLE_MODES),
    ("motor_vehicle", MOTORBIKE | CAR),
    ("motorcycle", MOTORBIKE),
    ("motorcar", CAR),
    ("bicycle", BICYCLE),
    ("foot", FOOT),
)
GENERAL_TAGS = {"access", "vehicle", "motor_vehicle"}
# Default speeds (km/h) by class when OSM has no maxspeed; used only for time estimates.
DEFAULT_SPEED_KMH = {
    "trunk": 40,
    "primary": 40,
    "secondary": 40,
    "tertiary": 30,
    "unclassified": 30,
    "residential": 30,
    "living_street": 15,
    "service": 15,
    "track": 15,
}


def access_masks(highway: str, tags: dict[str, str]) -> tuple[int, int]:
    """(modes allowed along the way, modes allowed against it)."""
    default = CLASS_MODES.get(highway, CLASS_MODES.get(highway.removesuffix("_link"), 0))
    modes = default
    for key, bits in TAG_MODES:
        value = (tags.get(key) or "").lower()
        if value in ALLOW:
            if key in GENERAL_TAGS:
                # `access=yes` re-opens what the class allows; it never puts motorbikes on
                # a footway.
                modes |= bits & default
            else:
                # A mode named explicitly (`motorcycle=yes` on a pedestrian street) is
                # allowed, except onto steps.
                modes |= bits if highway != "steps" else bits & FOOT
        elif value in DENY:
            modes &= ~bits
    oneway = (tags.get("oneway") or "").lower()
    if oneway in ("yes", "1", "true"):
        direction = 1
    elif oneway in ("-1", "reverse"):
        direction = -1
    elif oneway == "no":
        direction = 0
    else:
        direction = 1 if (tags.get("junction") or "").lower() in ("roundabout", "circular") else 0
    if direction == 0:
        return modes, modes
    bound = VEHICLE_MODES
    if (tags.get("oneway:bicycle") or "").lower() == "no":
        bound &= ~BICYCLE
    with_flow, against = modes, modes & ~bound
    return (with_flow, against) if direction == 1 else (against, with_flow)


def road_masks(road: RoadFeature) -> tuple[int, int]:
    return access_masks(road.highway, road.access)


def speed_kmh(highway: str, max_speed_kmh: int | None) -> int:
    return max_speed_kmh or DEFAULT_SPEED_KMH.get(highway.removesuffix("_link"), 20)


# ── graph ───────────────────────────────────────────────────────────────────────────────


@dataclass
class GraphNode:
    key: int  # OSM node id, or a negative synthetic key for clipped ends / id-less ways
    x: float
    z: float
    signal: bool = False


@dataclass
class GraphEdge:
    osm_way_id: int
    a: int  # node keys, in the way's direction
    b: int
    pts: list[tuple[float, float]]  # world metres, a → b
    length_m: float
    highway: str
    width_m: float
    access_fwd: int
    access_bwd: int
    max_speed_kmh: int | None
    names: tuple[str | None, str | None, str | None] = field(default=(None, None, None))


def synthetic_key(x: float, z: float) -> int:
    """Stable negative key for a node without an OSM id (2 cm grid)."""
    return -(((round(x * 50) * 73856093) ^ (round(z * 50) * 19349663)) % (2**53)) - 1


def _orient_like(piece: LineString, original: LineString) -> LineString:
    a = original.project(Point(piece.coords[0]))
    b = original.project(Point(piece.coords[-1]))
    return piece if a <= b else LineString(list(piece.coords)[::-1])


def line_pieces(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom] if geom.length > 0 else []
    return [g for part in getattr(geom, "geoms", []) for g in line_pieces(part)]


def oriented_pieces(world: LineString, area: Polygon) -> list[LineString]:
    """`world ∩ area` as lines that keep the original direction (GEOS may reverse pieces)."""
    return [_orient_like(p, world) for p in line_pieces(world.intersection(area))]


def build_graph(
    roads: list[RoadFeature],
    projection: WorldProjection,
    keep: Polygon,
    signals: set[int] | None = None,
) -> tuple[dict[int, GraphNode], list[GraphEdge]]:
    """Split routable ways at junction nodes into edges (world metres) inside `keep`."""
    signals = signals or set()
    ways: list[tuple[RoadFeature, list[int], list[tuple[float, float]], tuple[int, int]]] = []
    uses: Counter[int] = Counter()
    for road in roads:
        fwd, bwd = road_masks(road)
        if not (fwd | bwd):
            continue
        world = projection.geometry_to_world(road.geom)
        pts = [(float(x), float(z)) for x, z in world.coords]
        keys = road.node_ids if len(road.node_ids) == len(pts) else [synthetic_key(*p) for p in pts]
        # Drop consecutive duplicates (a repeated node adds no geometry).
        dedup_k, dedup_p = [keys[0]], [pts[0]]
        for k, p in zip(keys[1:], pts[1:], strict=True):
            if k != dedup_k[-1]:
                dedup_k.append(k)
                dedup_p.append(p)
        if len(dedup_k) < 2:
            continue
        ways.append((road, dedup_k, dedup_p, (fwd, bwd)))
        uses.update(dedup_k)
        uses.update((dedup_k[0], dedup_k[-1]))  # way ends always split

    nodes: dict[int, GraphNode] = {}
    edges: list[GraphEdge] = []

    def node(key: int, x: float, z: float) -> int:
        if key not in nodes:
            nodes[key] = GraphNode(key, round(x, 2), round(z, 2), key in signals)
        return key

    for road, keys, pts, (fwd, bwd) in ways:
        start = 0
        for i in range(1, len(keys)):
            if uses[keys[i]] < 2 and i < len(keys) - 1:
                continue
            seg_keys, seg_pts = keys[start : i + 1], pts[start : i + 1]
            start = i
            line = LineString(seg_pts)
            if line.length < 0.05:
                continue
            if keep.covers(line):
                pieces = [(line, seg_keys[0], seg_keys[-1])]
            else:
                pieces = []
                for piece in oriented_pieces(line, keep):
                    p0, p1 = piece.coords[0], piece.coords[-1]
                    ka = seg_keys[0] if Point(p0).distance(Point(seg_pts[0])) < 1e-6 else None
                    kb = seg_keys[-1] if Point(p1).distance(Point(seg_pts[-1])) < 1e-6 else None
                    r0, r1 = (round(p0[0], 2), round(p0[1], 2)), (round(p1[0], 2), round(p1[1], 2))
                    pieces.append((piece, ka or synthetic_key(*r0), kb or synthetic_key(*r1)))
            for piece, ka, kb in pieces:
                coords = [(round(x, 2), round(z, 2)) for x, z in piece.coords]
                if piece.length < 0.05:
                    continue
                edges.append(
                    GraphEdge(
                        osm_way_id=road.osm_id,
                        a=node(ka, *coords[0]),
                        b=node(kb, *coords[-1]),
                        pts=coords,
                        length_m=round(piece.length, 2),
                        highway=road.highway,
                        width_m=road.width_m,
                        access_fwd=fwd,
                        access_bwd=bwd,
                        max_speed_kmh=road.max_speed_kmh,
                        names=(road.name, road.name_en, road.name_km),
                    )
                )
    return nodes, edges


def bearing_deg(ax: float, az: float, bx: float, bz: float) -> float:
    """Compass bearing (0 = north, clockwise) of the world vector a → b (z = -north)."""
    return (math.degrees(math.atan2(bx - ax, -(bz - az))) + 360) % 360
