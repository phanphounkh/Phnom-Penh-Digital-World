"""Parse Overpass `out geom` JSON into typed features with shapely geometries (lon/lat).

Pure functions, no database access, so they can be tested in isolation. Values that OSM does
not provide (road widths, building heights) are *estimated* and the estimate is labelled via
`width_source` / `height_source`, so the world never presents guesses as surveyed data.
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass, field
from typing import Any

from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import linemerge, polygonize, unary_union

ROAD_WIDTHS_M = {
    "motorway": 18.0,
    "trunk": 16.0,
    "primary": 14.0,
    "secondary": 11.0,
    "tertiary": 9.0,
    "unclassified": 7.0,
    "residential": 6.5,
    "living_street": 5.0,
    "service": 4.5,
    "pedestrian": 6.0,
    "track": 3.5,
    "footway": 2.5,
    "path": 2.0,
    "cycleway": 2.5,
    "steps": 2.5,
}
LINK_WIDTH_M = 7.0
ROAD_CLASSES = set(ROAD_WIDTHS_M) | {
    f"{c}_link" for c in ("motorway", "trunk", "primary", "secondary", "tertiary")
}

LEVEL_HEIGHT_M = 3.3
# Typical storeys by building type. "yes" (unspecified) is varied deterministically 2–5 storeys,
# matching Daun Penh's shophouse fabric; every such height is flagged `estimated`.
DEFAULT_LEVELS = {
    "house": 3,
    "detached": 2,
    "residential": 4,
    "apartments": 6,
    "terrace": 3,
    "commercial": 4,
    "retail": 2,
    "hotel": 7,
    "office": 6,
    "industrial": 2,
    "warehouse": 2,
    "school": 3,
    "university": 4,
    "hospital": 4,
    "public": 3,
    "government": 3,
    "civic": 3,
    "temple": 1,
    "religious": 1,
    "church": 2,
    "mosque": 2,
    "monastery": 2,
    "pagoda": 2,
    "kiosk": 1,
    "roof": 1,
    "garage": 1,
    "garages": 1,
    "shed": 1,
    "hut": 1,
    "service": 1,
    "construction": 2,
    "parking": 3,
    "train_station": 2,
    "transportation": 1,
}
ROOF_ONLY = {"roof", "carport"}

AREA_KINDS: list[tuple[str, str, str]] = [
    ("natural", "water", "water"),
    ("waterway", "riverbank", "water"),
    ("leisure", "swimming_pool", "water"),
    ("natural", "wetland", "wetland"),
    ("leisure", "park", "park"),
    ("leisure", "garden", "park"),
    ("natural", "wood", "park"),
    ("landuse", "grass", "grass"),
    ("landuse", "village_green", "grass"),
    ("landuse", "recreation_ground", "park"),
    ("leisure", "pitch", "pitch"),
    ("leisure", "playground", "pitch"),
    ("leisure", "fitness_station", "pitch"),
    ("place", "square", "plaza"),
    ("amenity", "marketplace", "plaza"),
    ("amenity", "parking", "parking"),
    ("landuse", "religious", "temple_grounds"),
    ("amenity", "place_of_worship", "temple_grounds"),
]

LANDMARK_KEYS = ("tourism", "historic", "amenity", "shop", "office", "leisure", "craft")
IMPORTANT = {
    ("tourism", "attraction"): 3,
    ("tourism", "museum"): 3,
    ("historic", "*"): 3,
    ("amenity", "marketplace"): 3,
    ("amenity", "place_of_worship"): 3,
    ("amenity", "townhall"): 2,
    ("amenity", "post_office"): 2,
    ("amenity", "bank"): 2,
    ("amenity", "hospital"): 2,
    ("amenity", "school"): 2,
    ("amenity", "university"): 2,
    ("tourism", "hotel"): 2,
    ("amenity", "police"): 2,
    ("amenity", "library"): 2,
}
STREET_FEATURES = {
    ("natural", "tree"): "tree",
    ("highway", "traffic_signals"): "traffic_signals",
    ("highway", "street_lamp"): "street_lamp",
    ("highway", "crossing"): "crossing",
}


@dataclass
class Named:
    osm_type: str
    osm_id: int
    name: str | None
    name_en: str | None
    name_km: str | None


@dataclass
class RoadFeature(Named):
    highway: str
    ref: str | None
    lanes: int | None
    oneway: bool
    width_m: float
    width_source: str
    surface: str | None
    layer: int
    is_bridge: bool
    geom: LineString


@dataclass
class BuildingFeature(Named):
    building: str
    levels: int | None
    height_m: float
    min_height_m: float
    height_source: str
    colour: str | None
    roof_shape: str | None
    address: str | None
    geom: MultiPolygon


@dataclass
class AreaFeature(Named):
    kind: str
    geom: MultiPolygon


@dataclass
class LandmarkFeature(Named):
    category: str
    subtype: str
    importance: int
    geom: Point


@dataclass
class StreetPointFeature:
    osm_type: str
    osm_id: int
    kind: str
    geom: Point


@dataclass
class PlaceFeature(Named):
    kind: str
    geom: Point


@dataclass
class ParsedArea:
    roads: list[RoadFeature] = field(default_factory=list)
    buildings: list[BuildingFeature] = field(default_factory=list)
    areas: list[AreaFeature] = field(default_factory=list)
    landmarks: list[LandmarkFeature] = field(default_factory=list)
    street_features: list[StreetPointFeature] = field(default_factory=list)


# ── helpers ─────────────────────────────────────────────────────────────────────────────
_NUMBER = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(m|meters|metres)?\s*$", re.IGNORECASE)


def parse_metres(value: str | None) -> float | None:
    if not value:
        return None
    match = _NUMBER.match(value.replace(",", "."))
    return float(match.group(1)) if match else None


def parse_int(value: str | None) -> int | None:
    number = parse_metres(value)
    return round(number) if number is not None else None


def names(tags: dict[str, str]) -> tuple[str | None, str | None, str | None]:
    name = tags.get("name") or tags.get("name:en") or tags.get("name:km")
    return name, tags.get("name:en"), tags.get("name:km")


def _coords(geometry: list[dict[str, float] | None]) -> list[tuple[float, float]]:
    return [(p["lon"], p["lat"]) for p in geometry if p]


def _runs(geometry: list[dict[str, float] | None]) -> list[list[tuple[float, float]]]:
    """Contiguous runs of known coordinates (Overpass may return null for some nodes)."""
    runs: list[list[tuple[float, float]]] = [[]]
    for p in geometry:
        if p:
            runs[-1].append((p["lon"], p["lat"]))
        elif runs[-1]:
            runs.append([])
    return [r for r in runs if len(r) >= 2]


def is_complete(geometry: list[dict[str, float] | None]) -> bool:
    return bool(geometry) and all(geometry)


def way_line(element: dict[str, Any]) -> LineString | None:
    # Never bridge a gap of unknown nodes with a straight segment: keep the longest known run.
    runs = _runs(element.get("geometry") or [])
    return LineString(max(runs, key=len)) if runs else None


def way_polygon(element: dict[str, Any]) -> Polygon | None:
    geometry = element.get("geometry") or []
    if not is_complete(geometry):
        return None  # partial geometry would cut straight across land
    coords = _coords(geometry)
    if len(coords) < 4 or coords[0] != coords[-1]:
        return None
    return Polygon(coords)


def relation_multipolygon(element: dict[str, Any]) -> MultiPolygon | None:
    """Assemble a multipolygon relation from its member ways (outer minus inner rings)."""
    lines: dict[str, list[LineString]] = {"outer": [], "inner": []}
    for member in element.get("members", []):
        if member.get("type") != "way":
            continue
        if not is_complete(member.get("geometry") or []):
            return None  # an incomplete ring cannot be assembled reliably
        coords = _coords(member.get("geometry") or [])
        if len(coords) >= 2:
            lines["inner" if member.get("role") == "inner" else "outer"].append(LineString(coords))
    if not lines["outer"]:
        return None
    outer = unary_union(list(polygonize(linemerge(lines["outer"]))))
    if outer.is_empty:
        return None
    if lines["inner"]:
        inner = unary_union(list(polygonize(linemerge(lines["inner"]))))
        outer = outer.difference(inner)
    return as_multipolygon(outer)


def as_multipolygon(geom: BaseGeometry | None) -> MultiPolygon | None:
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if isinstance(geom, Polygon):
        return MultiPolygon([geom])
    if isinstance(geom, MultiPolygon):
        return geom
    polygons = [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon) and not g.is_empty]
    return MultiPolygon(polygons) if polygons else None


def element_area(element: dict[str, Any]) -> MultiPolygon | None:
    if element["type"] == "way":
        return as_multipolygon(way_polygon(element))
    if element["type"] == "relation":
        return relation_multipolygon(element)
    return None


def representative_point(element: dict[str, Any]) -> Point | None:
    if element["type"] == "node":
        return Point(element["lon"], element["lat"])
    if "center" in element:
        return Point(element["center"]["lon"], element["center"]["lat"])
    area = element_area(element)
    if area is not None:
        return area.representative_point()
    if element["type"] == "way":
        line = way_line(element)
        return line.interpolate(0.5, normalized=True) if line else None
    return None


# ── feature classification ──────────────────────────────────────────────────────────────
def road_from(element: dict[str, Any]) -> RoadFeature | None:
    tags = element.get("tags", {})
    highway = tags.get("highway")
    if element["type"] != "way" or highway not in ROAD_CLASSES or tags.get("area") == "yes":
        return None
    line = way_line(element)
    if line is None or line.length == 0:
        return None
    lanes = parse_int(tags.get("lanes"))
    width = parse_metres(tags.get("width"))
    if width and 1 <= width <= 60:
        source = "osm"
    elif lanes and 1 <= lanes <= 10:
        width, source = lanes * 3.25 + 1.0, "lanes"
    else:
        width = LINK_WIDTH_M if highway.endswith("_link") else ROAD_WIDTHS_M[highway]
        source = "estimated"
    return RoadFeature(
        "way",
        element["id"],
        *names(tags),
        highway=highway,
        ref=tags.get("ref"),
        lanes=lanes,
        oneway=tags.get("oneway") in ("yes", "1", "true") or tags.get("junction") == "roundabout",
        width_m=round(width, 2),
        width_source=source,
        surface=tags.get("surface"),
        layer=parse_int(tags.get("layer")) or 0,
        is_bridge=tags.get("bridge") not in (None, "no"),
        geom=line,
    )


def building_from(element: dict[str, Any]) -> BuildingFeature | None:
    tags = element.get("tags", {})
    kind = tags.get("building")
    if not kind or kind == "no" or element["type"] == "node":
        return None
    geom = element_area(element)
    if geom is None:
        return None
    levels = parse_int(tags.get("building:levels"))
    height = parse_metres(tags.get("height"))
    min_height = parse_metres(tags.get("min_height")) or 0.0
    if height and 2 <= height <= 400:
        source = "osm"
    elif levels and 1 <= levels <= 100:
        height, source = levels * LEVEL_HEIGHT_M + 0.6, "levels"
    else:
        estimate = DEFAULT_LEVELS.get(kind)
        if estimate is None:
            # Stable per-building variety (zlib.crc32 is deterministic across runs).
            estimate = 2 + zlib.crc32(str(element["id"]).encode()) % 4
        height, source = estimate * LEVEL_HEIGHT_M + 0.6, "estimated"
    if kind in ROOF_ONLY:
        min_height = max(min_height, height - 0.6)
    street = tags.get("addr:street")
    number = tags.get("addr:housenumber")
    address = " ".join(p for p in (number, street) if p) or None
    return BuildingFeature(
        element["type"],
        element["id"],
        *names(tags),
        building=kind,
        levels=levels,
        height_m=round(height, 2),
        min_height_m=round(min_height, 2),
        height_source=source,
        colour=tags.get("building:colour"),
        roof_shape=tags.get("roof:shape"),
        address=address,
        geom=geom,
    )


def area_from(element: dict[str, Any]) -> AreaFeature | None:
    if element["type"] == "node":
        return None
    tags = element.get("tags", {})
    kind = next((k for key, value, k in AREA_KINDS if tags.get(key) == value), None)
    if kind is None:
        return None
    geom = element_area(element)
    if geom is None:
        return None
    return AreaFeature(element["type"], element["id"], *names(tags), kind=kind, geom=geom)


def landmark_from(element: dict[str, Any]) -> LandmarkFeature | None:
    tags = element.get("tags", {})
    name, name_en, name_km = names(tags)
    if not name:
        return None
    category = next((k for k in LANDMARK_KEYS if k in tags), None)
    if category is None:
        return None
    subtype = tags[category]
    point = representative_point(element)
    if point is None:
        return None
    importance = IMPORTANT.get((category, subtype), IMPORTANT.get((category, "*"), 1))
    return LandmarkFeature(
        element["type"],
        element["id"],
        name,
        name_en,
        name_km,
        category=category,
        subtype=subtype[:48],
        importance=importance,
        geom=point,
    )


def street_features_from(element: dict[str, Any]) -> list[StreetPointFeature]:
    tags = element.get("tags", {})
    if element["type"] == "node":
        for (key, value), kind in STREET_FEATURES.items():
            if tags.get(key) == value:
                return [
                    StreetPointFeature(
                        "node", element["id"], kind, Point(element["lon"], element["lat"])
                    )
                ]
        return []
    if element["type"] == "way" and tags.get("natural") == "tree_row":
        line = way_line(element)
        if line is None:
            return []
        # ~8 m spacing; degrees are converted roughly here only to choose a sample count.
        approx_m = line.length * 111_000
        count = max(2, int(approx_m // 8) + 1)
        return [
            StreetPointFeature(
                "way_pt",
                element["id"] * 1000 + i,
                "tree",
                line.interpolate(i / (count - 1), normalized=True),
            )
            for i in range(count)
        ]
    return []


def parse_area(elements: list[dict[str, Any]]) -> ParsedArea:
    parsed = ParsedArea()
    for element in elements:
        if road := road_from(element):
            parsed.roads.append(road)
            continue
        building = building_from(element)
        if building:
            parsed.buildings.append(building)
        elif area := area_from(element):
            parsed.areas.append(area)
        if landmark := landmark_from(element):
            parsed.landmarks.append(landmark)
        parsed.street_features.extend(street_features_from(element))
    return parsed


PLACE_KINDS = {"suburb", "quarter", "neighbourhood", "village", "town", "city"}


def place_from(element: dict[str, Any]) -> PlaceFeature | None:
    tags = element.get("tags", {})
    name, name_en, name_km = names(tags)
    if not name:
        return None
    if tags.get("place") in PLACE_KINDS:
        kind = tags["place"]
    elif tags.get("boundary") == "administrative" and tags.get("admin_level") == "6":
        kind = "khan"
    elif tags.get("boundary") == "administrative" and tags.get("admin_level") in ("7", "8"):
        kind = "sangkat"
    elif tags.get("amenity") in ("marketplace", "university", "hospital"):
        kind = tags["amenity"]
    elif tags.get("tourism") in ("attraction", "museum", "viewpoint"):
        kind = tags["tourism"]
    else:
        return None
    point = representative_point(element)
    if point is None:
        return None
    return PlaceFeature(
        element["type"], element["id"], name, name_en, name_km, kind=kind, geom=point
    )


def boundary_multipolygon(elements: list[dict[str, Any]]) -> MultiPolygon | None:
    for element in elements:
        if element["type"] == "relation":
            return relation_multipolygon(element)
    return None
