"""Geography: projection, OSM parsing, the imported data and the public geo/world API."""

import math

import httpx
import pytest
from shapely.geometry import Point
from sqlalchemy import text

from app.core.database import SessionLocal
from app.geography import osm
from app.geography.projection import default_projection, geodesic_distance_m
from tests.conftest import CENTRAL_MARKET

# ── projection ──────────────────────────────────────────────────────────────────────────


def test_origin_maps_to_zero_and_round_trips():
    p = default_projection()
    x, z = p.to_world(p.origin_lat, p.origin_lon)
    assert abs(x) < 1e-6 and abs(z) < 1e-6
    for lat, lon in [(11.5765, 104.9230), (11.5650, 104.9330), (11.5500, 104.8800)]:
        back = p.to_latlon(*p.to_world(lat, lon))
        assert abs(back[0] - lat) < 1e-9 and abs(back[1] - lon) < 1e-9


def test_axes_east_is_plus_x_north_is_minus_z():
    p = default_projection()
    east = p.to_world(p.origin_lat, p.origin_lon + 0.001)
    north = p.to_world(p.origin_lat + 0.001, p.origin_lon)
    assert east[0] > 100 and abs(east[1]) < 1
    assert north[1] < -100 and abs(north[0]) < 1


def test_world_distances_match_geodesic_distances():
    p = default_projection()
    a, b = (11.5696, 104.9211), (11.5763, 104.9232)  # Central Market → Wat Phnom
    ax, az = p.to_world(*a)
    bx, bz = p.to_world(*b)
    planar = math.hypot(bx - ax, bz - az)
    geodesic = geodesic_distance_m(*a, *b)
    assert 700 < geodesic < 800
    assert abs(planar - geodesic) / geodesic < 0.001  # UTM scale error well under 0.1 %


def test_chunk_indexing():
    p = default_projection()
    assert p.chunk_of(0, 0) == (0, 0)
    assert p.chunk_of(-0.01, 199.99) == (-1, 0)
    assert p.chunk_bounds(-1, 2) == (-200, 400, 0, 600)


# ── OSM parsing ─────────────────────────────────────────────────────────────────────────


def _way(tags, coords, id_=1):
    return {
        "type": "way",
        "id": id_,
        "tags": tags,
        "geometry": [{"lat": lat, "lon": lon} for lat, lon in coords],
    }


SQUARE = [(11.0, 104.0), (11.0, 104.001), (11.001, 104.001), (11.001, 104.0), (11.0, 104.0)]


def test_road_width_sources():
    line = [(11.0, 104.0), (11.001, 104.0)]
    assert osm.road_from(_way({"highway": "primary", "width": "18 m"}, line)).width_source == "osm"
    lanes = osm.road_from(_way({"highway": "primary", "lanes": "4"}, line))
    assert (lanes.width_source, lanes.width_m) == ("lanes", 14.0)
    estimated = osm.road_from(_way({"highway": "residential"}, line))
    assert (estimated.width_source, estimated.width_m) == ("estimated", 6.5)
    assert osm.road_from(_way({"highway": "pedestrian", "area": "yes"}, SQUARE)) is None
    assert osm.road_from(_way({"highway": "primary", "junction": "roundabout"}, line)).oneway


def test_building_height_sources_are_labelled():
    assert (
        osm.building_from(_way({"building": "yes", "height": "118"}, SQUARE)).height_source == "osm"
    )
    levels = osm.building_from(_way({"building": "yes", "building:levels": "5"}, SQUARE))
    assert levels.height_source == "levels" and levels.height_m == pytest.approx(17.1)
    guess = osm.building_from(_way({"building": "yes"}, SQUARE, id_=42))
    assert guess.height_source == "estimated"
    assert osm.building_from(_way({"building": "yes"}, SQUARE, id_=42)).height_m == guess.height_m
    assert osm.building_from(_way({"building": "yes"}, SQUARE[:-1])) is None  # not closed


def test_multipolygon_relation_with_courtyard():
    outer = SQUARE
    inner = [
        (11.0004, 104.0004),
        (11.0004, 104.0006),
        (11.0006, 104.0006),
        (11.0006, 104.0004),
        (11.0004, 104.0004),
    ]
    relation = {
        "type": "relation",
        "id": 7,
        "tags": {"building": "yes", "type": "multipolygon"},
        "members": [
            {"type": "way", "role": "outer", "geometry": [{"lat": a, "lon": b} for a, b in outer]},
            {"type": "way", "role": "inner", "geometry": [{"lat": a, "lon": b} for a, b in inner]},
        ],
    }
    building = osm.building_from(relation)
    assert len(building.geom.geoms[0].interiors) == 1
    assert not building.geom.contains(Point(104.0005, 11.0005))


def test_partial_geometry_never_bridges_gaps():
    # Overpass returns null for nodes it did not include; joining the remaining nodes would
    # draw a straight edge across land (this once turned the city side of the river into water).
    partial = _way({"natural": "water"}, SQUARE)
    partial["geometry"][2] = None
    assert osm.area_from(partial) is None
    road = _way(
        {"highway": "residential"},
        [(11.0, 104.0), (11.001, 104.0), (11.002, 104.0), (11.003, 104.0), (11.004, 104.0)],
    )
    road["geometry"][1] = None
    line = osm.road_from(road)
    assert len(line.geom.coords) == 3  # the longest contiguous run, not a bridged line


def test_area_and_landmark_classification():
    assert osm.area_from(_way({"leisure": "park"}, SQUARE)).kind == "park"
    assert osm.area_from(_way({"natural": "water", "water": "river"}, SQUARE)).kind == "water"
    node = {
        "type": "node",
        "id": 3,
        "lat": 11.0,
        "lon": 104.0,
        "tags": {"amenity": "marketplace", "name": "Phsar Thmei"},
    }
    landmark = osm.landmark_from(node)
    assert (landmark.category, landmark.subtype, landmark.importance) == (
        "amenity",
        "marketplace",
        3,
    )
    assert osm.landmark_from({**node, "tags": {"amenity": "bench"}}) is None  # unnamed


# ── imported data ───────────────────────────────────────────────────────────────────────


async def test_import_produced_real_neighbourhood(imported_geography):
    stats = imported_geography["daun-penh-central"]
    assert stats["buildings"] > 2000 and stats["roads"] > 500 and stats["chunks"] > 50
    assert imported_geography["city"]["boundary"] == "osm-relation"


async def test_spawn_points_are_on_open_public_ground():
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                text("""
          SELECT s.slug,
            EXISTS (SELECT 1 FROM buildings b WHERE ST_Contains(b.footprint, s.location)) AS inside,
            ST_Contains(r.boundary, s.location) AS in_region
          FROM player_spawn_points s JOIN geographic_regions r ON r.id = s.region_id
        """)
            )
        ).all()
    assert len(rows) >= 5
    assert all(not r.inside and r.in_region for r in rows)


async def test_reimport_keeps_building_ids_stable():
    from app.core.config import settings
    from app.geography.importer import import_neighborhood

    query = text("SELECT id FROM buildings WHERE osm_type = 'way' ORDER BY osm_id LIMIT 50")
    async with SessionLocal() as session:
        before = (await session.scalars(query)).all()
        stats = await import_neighborhood(session, settings.osm_data_dir, "daun-penh-central")
        await session.commit()
        after = (await session.scalars(query)).all()
    assert before == after and stats["buildings_pruned"] == 0


# ── public API ──────────────────────────────────────────────────────────────────────────


async def test_world_config_and_chunk_streaming(client: httpx.AsyncClient):
    config = (await client.get("/world/config")).json()
    assert config["crs"] == "EPSG:32648"
    assert "OpenStreetMap" in config["attribution"]
    region = config["regions"][0]
    assert region["slug"] == "daun-penh-central"
    assert "0_0" in region["chunk_keys"]  # the origin chunk (Central Market)
    first = await client.get("/world/chunks/0_0")
    assert first.status_code == 200
    chunk = first.json()
    assert chunk["buildings"] and chunk["roads"]
    building = chunk["buildings"][0]
    assert building["hs"] in ("osm", "levels", "estimated") and building["polys"][0][0]
    etag = first.headers["etag"]
    cached = await client.get("/world/chunks/0_0", headers={"If-None-Match": etag})
    assert cached.status_code == 304
    assert (await client.get("/world/chunks/999_999")).status_code == 404
    assert (await client.get("/world/chunks/../etc")).status_code in (404, 422)


async def test_search_finds_real_places(client: httpx.AsyncClient):
    market = (await client.get("/geo/search", params={"q": "central market"})).json()
    assert market and market[0]["name_en"] == "Central Market"
    assert market[0]["in_playable_area"] is True
    khan = (await client.get("/geo/search", params={"q": "toul kork"})).json()
    assert any(r["kind"] == "khan" and r["in_service_area"] for r in khan)
    khmer = (await client.get("/geo/search", params={"q": "ផ្សារធំថ្មី"})).json()
    assert khmer


async def test_reverse_lookup_and_nearby_buildings(client: httpx.AsyncClient):
    lat, lon = CENTRAL_MARKET
    rev = (await client.get("/geo/reverse", params={"lat": lat, "lon": lon})).json()
    assert rev["in_playable_area"] and rev["in_service_area"]
    assert rev["street"] and abs(rev["world"]["x"]) < 1 and abs(rev["world"]["z"]) < 1
    nearby = (
        await client.get("/geo/buildings/nearby", params={"lat": lat, "lon": lon, "radius_m": 150})
    ).json()
    distances = [b["distance_m"] for b in nearby]
    assert nearby and distances == sorted(distances) and distances[-1] <= 150
    far = await client.get("/geo/reverse", params={"lat": 40.0, "lon": 104.9})
    assert far.status_code == 422
