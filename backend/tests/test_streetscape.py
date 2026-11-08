"""Phase 2 geography: terrain, landmark overrides, stupas, street signs and generated lamps."""

import math

import httpx
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree
from sqlalchemy import text

from app.core.database import SessionLocal
from app.geography import osm
from app.geography.streetscape import (
    NamedLine,
    generated_lamps,
    merge_streets,
    minimum_rectangle,
    street_signs,
)
from app.geography.terrain import Mound, default_mounds, height_at

# ── terrain ─────────────────────────────────────────────────────────────────────────────


def test_mound_profile():
    m = Mound("hill", 0, 0, 27.0, 24.0, 68.0, "test")
    assert height_at(0, 0, [m]) == 27.0
    assert height_at(24, 0, [m]) == 27.0
    assert height_at(46, 0, [m]) == 13.5  # half way down the slope
    assert height_at(68, 0, [m]) == 0.0
    assert height_at(500, 0, [m]) == 0.0
    # Monotonic descent.
    heights = [height_at(r, 0, [m]) for r in range(0, 70, 2)]
    assert heights == sorted(heights, reverse=True)


def test_shared_terrain_fixture_matches_client():
    # The same numbers are asserted in frontend/src/lib/game/city/terrain.test.ts.
    m = default_mounds()[0]
    assert (m.x, m.z) == (225.89, -727.52)
    assert abs(height_at(m.x + 30, m.z) - 25.780032) < 1e-5
    assert abs(height_at(m.x + 50, m.z + 10) - 8.79109) < 1e-5


async def test_world_config_exposes_terrain(client: httpx.AsyncClient):
    terrain = (await client.get("/world/config")).json()["terrain"]
    assert terrain[0]["slug"] == "wat-phnom-hill"
    assert terrain[0]["height_m"] == 27.0
    assert "not surveyed" in terrain[0]["source"]


# ── landmarks ───────────────────────────────────────────────────────────────────────────


def test_stupas_mapped_as_towers_become_buildings():
    ring = [(104.0, 11.0), (104.0001, 11.0), (104.0001, 11.0001), (104.0, 11.0001), (104.0, 11.0)]
    element = {
        "type": "way",
        "id": 5,
        "tags": {"man_made": "tower", "tower:type": "stupa"},
        "geometry": [{"lat": lat, "lon": lon} for lon, lat in ring],
    }
    assert osm.building_from(element).building == "stupa"
    element["tags"] = {"man_made": "tower", "tower:type": "communication"}
    assert osm.building_from(element) is None


async def test_landmark_overrides_reach_the_chunks():
    async with SessionLocal() as session:
        rows = (
            await session.execute(
                text("""
            SELECT b->>'kind' AS kind, (b->>'h')::float AS h, b->>'hs' AS hs,
                   b->'model'->>'name' AS model, b->'roof'->>'type' AS roof
            FROM world_chunks c, jsonb_array_elements(c.payload->'buildings') b
            WHERE b ? 'model' OR b ? 'roof'""")
            )
        ).all()
        hidden = await session.scalar(
            text("""
            SELECT count(*) FROM world_chunks c, jsonb_array_elements(c.payload->'buildings') b
            WHERE (b->>'id')::bigint IN
              (SELECT id FROM buildings WHERE osm_id IN (1034727803, 842087292))""")
        )
    models = {r.model: r for r in rows if r.model}
    assert models["phsar-thmei-dome"].h == 26.0 and models["phsar-thmei-dome"].hs == "reference"
    assert models["stupa"].kind == "stupa"
    assert any(r.roof == "khmer" for r in rows)
    assert hidden == 0  # the duplicate footprints are not rendered


def test_minimum_rectangle_orientation():
    rect = Polygon([(0, 0), (20, 0), (20, 6), (0, 6)])
    cx, cz, length, width, angle = minimum_rectangle(rect)
    assert (cx, cz, length, width) == (10, 3, 20, 6)
    assert abs(abs(math.sin(angle)) - 1) < 1e-6  # long side along x


# ── street signs and lamps ──────────────────────────────────────────────────────────────


def _line(name, coords, highway="tertiary", width=9.0):
    return NamedLine(name, f"{name} EN", f"{name} KM", highway, width, LineString(coords))


def test_signs_stand_at_real_intersections_off_the_road():
    roads = [
        _line("Street 136", [(-50, 0), (0, 0), (50, 0)]),
        _line("Street 53", [(0, -50), (0, 0), (0, 50)]),
        _line("Street 136", [(50, 0), (100, 0)]),  # same street continues: no sign at x=50
    ]
    signs = street_signs(roads)
    assert len(signs) == 1
    sign = signs[0]
    assert {b["en"] for b in sign["blades"]} == {"Street 136 EN", "Street 53 EN"}
    x, z = sign["p"]
    assert min(abs(x), abs(z)) > 4.5  # on the corner, not in the carriageway


def test_signs_avoid_buildings_and_merge_nearby_junctions():
    roads = [
        _line("A", [(-50, 0), (0, 0), (50, 0)]),
        _line("B", [(0, -50), (0, 0), (0, 50)]),
        _line("C", [(5, -50), (5, 0)]),  # a second junction 5 m away
    ]
    assert len(street_signs(roads)) == 1
    everywhere = STRtree([Polygon([(-30, -30), (30, -30), (30, 30), (-30, 30)])])
    assert street_signs(roads, obstacles=everywhere) == []


def test_lamps_follow_whole_streets_not_osm_fragments():
    # OSM splits a street at every junction; 25 m fragments would get no lamps on their own.
    fragments = [
        _line("Quay", [(i * 25, 0), ((i + 1) * 25, 0)], highway="secondary", width=11)
        for i in range(8)
    ]
    assert len(merge_streets(fragments)) == 1
    lamps = generated_lamps(fragments)
    assert len(lamps) == 200 // 32
    sides = {round(z, 1) for _, z, _ in lamps}
    assert sides == {6.2, -6.2}  # alternating sides, off the carriageway
    assert all(abs(a - math.pi / 2) < 1e-3 for *_, a in lamps)  # direction of the street


async def test_imported_streetscape(imported_geography):
    stats = imported_geography["daun-penh-central"]
    assert stats["street_signs"] > 100
    assert stats["generated_lamps"] > 500
    async with SessionLocal() as session:
        bad = await session.scalar(
            text("""
            SELECT count(*) FROM world_chunks c, jsonb_array_elements(c.payload->'signs') s,
              buildings b
            WHERE ST_Intersects(b.footprint, ST_Transform(ST_SetSRID(ST_MakePoint(
              (s->'p'->>0)::float + 491403.0801141087,
              1278957.2265911433 - (s->'p'->>1)::float), 32648), 4326))""")
        )
    assert bad == 0  # no sign stands inside a building
