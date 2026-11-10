"""Phase 5: the road graph and routing (pure functions and the imported Daun Penh network)."""

import itertools
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import httpx
import pytest
from shapely.geometry import LineString, Point, box
from sqlalchemy import text

from app.core.database import SessionLocal
from app.geography import osm
from app.geography.projection import default_projection
from app.transport import specs
from app.transport.network import access_masks, build_graph, synthetic_key
from app.transport.specs import BICYCLE, CAR, FOOT, MOTORBIKE

ALL = FOOT | BICYCLE | MOTORBIKE | CAR
MARKET = (11.56955, 104.92115)
WAT_PHNOM = (11.57613, 104.92322)


# ── access rules (pure) ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("highway", "tags", "expected"),
    [
        ("residential", {}, (ALL, ALL)),
        ("primary", {"oneway": "yes"}, (ALL, FOOT)),  # pedestrians walk both ways
        ("primary", {"oneway": "-1"}, (FOOT, ALL)),
        ("tertiary", {"junction": "roundabout"}, (ALL, FOOT)),
        ("tertiary", {"junction": "roundabout", "oneway": "no"}, (ALL, ALL)),
        ("residential", {"oneway": "yes", "oneway:bicycle": "no"}, (ALL, FOOT | BICYCLE)),
        ("footway", {}, (FOOT | BICYCLE, FOOT | BICYCLE)),
        ("footway", {"access": "yes"}, (FOOT | BICYCLE, FOOT | BICYCLE)),  # never motorbikes
        ("steps", {"bicycle": "yes"}, (FOOT, FOOT)),  # nothing rides up steps
        ("service", {"access": "private"}, (0, 0)),
        ("service", {"access": "private", "foot": "yes"}, (FOOT, FOOT)),
        ("pedestrian", {"motorcycle": "yes"}, (FOOT | BICYCLE | MOTORBIKE,) * 2),
        ("residential", {"motor_vehicle": "no"}, (FOOT | BICYCLE,) * 2),
        ("residential", {"motor_vehicle": "no", "motorcycle": "yes"}, (ALL & ~CAR,) * 2),
        ("service", {"motorcar": "no"}, (ALL & ~CAR,) * 2),
    ],
)
def test_access_masks_follow_osm_tags(highway, tags, expected):
    assert access_masks(highway, tags) == expected


def test_speed_limits_are_parsed():
    assert osm.parse_speed_kmh("40") == 40
    assert osm.parse_speed_kmh("30 km/h") == 30
    assert osm.parse_speed_kmh("20 mph") == 32
    assert osm.parse_speed_kmh("walk") is None
    assert osm.parse_speed_kmh("900") is None


def _way(way_id, tags, coords, nodes):
    return {
        "type": "way",
        "id": way_id,
        "tags": tags,
        "nodes": nodes,
        "geometry": [{"lat": lat, "lon": lon} for lat, lon in coords],
    }


def test_ways_are_split_at_shared_nodes_and_clipped_to_the_area():
    """A cross of two streets sharing node 5 becomes four edges meeting at a degree-4 node;
    an edge leaving the area is cut there, ending in a synthetic dead-end node."""
    p = default_projection()
    lat0, lon0 = MARKET
    d = 0.001  # ~110 m
    ns = osm.road_from(
        _way(
            1,
            {"highway": "residential", "name": "Street A"},
            [(lat0 + d, lon0), (lat0, lon0), (lat0 - d, lon0)],
            [4, 5, 6],
        )
    )
    ew = osm.road_from(
        _way(
            2,
            {"highway": "residential", "oneway": "yes"},
            [(lat0, lon0 - d), (lat0, lon0), (lat0, lon0 + d)],
            [7, 5, 8],
        )
    )
    keep = box(-500, -500, 500, 500)
    nodes, edges = build_graph([ns, ew], p, keep, signals={5})
    assert len(edges) == 4
    degree = Counter(k for e in edges for k in (e.a, e.b))
    assert degree[5] == 4 and nodes[5].signal
    one_way = [e for e in edges if e.osm_way_id == 2]
    assert all((e.access_fwd, e.access_bwd) == (ALL, FOOT) for e in one_way)
    assert sum(e.length_m for e in edges) == pytest.approx(4 * 110, rel=0.03)

    # Clip: keep only the area within ~50 m east of the junction.
    x5, z5 = p.to_world(lat0, lon0)
    nodes, edges = build_graph([ns, ew], p, box(x5 - 10, z5 - 10, x5 + 50, z5 + 10))
    assert len(edges) == 4  # four arms, each cut at the box
    e = next(e for e in edges if e.osm_way_id == 2 and e.pts[-1][0] > x5 + 1)
    assert e.a == 5 and e.b < 0  # the clipped end is synthetic
    assert e.length_m == pytest.approx(50, abs=0.5)
    assert all(sorted((edge.a, edge.b))[1] == 5 and min(edge.a, edge.b) < 0 for edge in edges)
    assert e.pts[0][0] < e.pts[-1][0]  # still pointing east, the way's direction
    assert synthetic_key(*e.pts[-1]) == e.b


def test_specs_fixture_is_shared_with_the_client():
    """frontend/src/lib/game/vehicles/specs.test.ts reads the same fixture file."""
    fixture = (
        Path(__file__).resolve().parents[2] / "frontend/src/lib/game/vehicles/specs.fixture.json"
    )
    assert json.loads(fixture.read_text()) == specs.as_fixture()


# ── the imported network ────────────────────────────────────────────────────────────────


async def test_imported_road_graph_is_connected_and_consistent(imported_geography):
    stats = imported_geography["daun-penh-central"]
    assert stats["road_nodes"] > 900 and stats["road_edges"] > 1200
    assert stats["oneway_edges"] > 100  # Daun Penh has many one-way streets
    async with SessionLocal() as session:
        edges = (
            await session.execute(
                text("""SELECT e.id, e.length_m, e.pts, a.x ax, a.z az, b.x bx, b.z bz,
                               e.access_fwd, e.access_bwd
                        FROM road_edges e JOIN road_nodes a ON a.id = e.from_node_id
                        JOIN road_nodes b ON b.id = e.to_node_id""")
            )
        ).all()
        signals = await session.scalar(text("SELECT count(*) FROM road_nodes WHERE is_signal"))
    assert signals >= 15  # mapped traffic signals sit on graph nodes
    for e in edges:
        assert LineString(e.pts).length == pytest.approx(e.length_m, abs=0.05)
        assert (e.ax, e.az) == pytest.approx(tuple(e.pts[0]), abs=0.01)
        assert (e.bx, e.bz) == pytest.approx(tuple(e.pts[-1]), abs=0.01)
        assert e.access_fwd | e.access_bwd  # nothing unusable is stored
    # One big connected street network (OSM fragments in private compounds aside).
    adj: dict[int, set[int]] = defaultdict(set)
    ends = {}
    for e in edges:
        a, b = (e.ax, e.az), (e.bx, e.bz)
        ends.setdefault(a, len(ends))
        ends.setdefault(b, len(ends))
        adj[ends[a]].add(ends[b])
        adj[ends[b]].add(ends[a])
    seen, stack = {0}, [0]
    while stack:
        for nxt in adj[stack.pop()] - seen:
            seen.add(nxt)
            stack.append(nxt)
    largest = max(len(seen), len(ends) - len(seen))
    assert largest / len(ends) > 0.85


async def test_chunk_roads_carry_direction_masks():
    async with SessionLocal() as session:
        payload = await session.scalar(text("SELECT payload FROM world_chunks WHERE key = '0_0'"))
    roads = payload["roads"]
    assert roads and all("af" in r and "ab" in r for r in roads)
    one_way = [r for r in roads if r["oneway"] and r["cls"] != "footway"]
    assert one_way and all(r["ab"] & MOTORBIKE == 0 and r["af"] & MOTORBIKE for r in one_way)


def world(lat: float, lon: float) -> tuple[float, float]:
    return default_projection().to_world(lat, lon)


async def test_route_on_real_streets(client: httpx.AsyncClient):
    (ax, az), (bx, bz) = world(*MARKET), world(*WAT_PHNOM)
    params = {"from_x": ax, "from_z": az, "to_x": bx, "to_z": bz}
    response = await client.get("/routes", params={**params, "mode": "motorbike"})
    assert response.status_code == 200, response.text
    route = response.json()
    straight = math.hypot(bx - ax, bz - az)
    assert straight < route["distance_m"] < straight * 2.5
    assert route["duration_s"] > route["distance_m"] / 13  # never faster than a motorbike
    steps = route["steps"]
    assert steps[0]["type"] == "depart" and steps[-1]["type"] == "arrive"
    assert any(s["type"] in ("left", "right", "slight_left", "slight_right") for s in steps)
    assert sum(s["distance_m"] for s in steps) == pytest.approx(route["distance_m"], abs=1.0)
    named = [s for s in steps if s["street"]]
    assert named and any(s["street_km"] for s in named)  # Khmer names travel along
    # The polyline is continuous and starts and ends at the snapped road positions.
    pts = route["points"]
    assert max(math.dist(p, q) for p, q in itertools.pairwise(pts)) < 120
    assert pts[0] == pytest.approx([route["from"]["x"], route["from"]["z"]], abs=0.05)
    assert pts[-1] == pytest.approx([route["to"]["x"], route["to"]["z"]], abs=0.05)
    walk = (await client.get("/routes", params={**params, "mode": "foot"})).json()
    assert walk["duration_s"] > route["duration_s"] * 2  # walking is much slower

    outside = await client.get("/routes", params={**params, "from_x": 9000, "mode": "foot"})
    assert outside.status_code == 422
    assert outside.json()["error"]["code"] == "OUTSIDE_PLAYABLE_AREA"
    bad = await client.get("/routes", params={**params, "mode": "jetpack"})
    assert bad.status_code == 422


async def test_one_way_streets_bind_vehicles_not_pedestrians(client: httpx.AsyncClient):
    async with SessionLocal() as session:
        edge = (
            await session.execute(
                text("""SELECT id, pts, length_m FROM road_edges
                        WHERE access_fwd & 4 > 0 AND access_bwd & 4 = 0 AND access_bwd & 1 > 0
                          AND highway IN ('primary','secondary','tertiary','residential')
                          AND length_m > 80 ORDER BY length_m DESC LIMIT 1""")
            )
        ).one()

    async def point(along: float) -> tuple[float, float]:
        r = await client.get("/roads/position", params={"edge": edge.id, "along_m": along})
        assert r.status_code == 200, r.text
        return r.json()["x"], r.json()["z"]

    p30, p70 = await point(edge.length_m * 0.3), await point(edge.length_m * 0.7)
    gap = edge.length_m * 0.4

    async def route(a, b, mode):
        r = await client.get(
            "/routes",
            params={"from_x": a[0], "from_z": a[1], "to_x": b[0], "to_z": b[1], "mode": mode},
        )
        assert r.status_code == 200, r.text
        return r.json()

    with_flow = await route(p30, p70, "motorbike")
    assert with_flow["distance_m"] == pytest.approx(gap, abs=1)
    against = await route(p70, p30, "motorbike")
    assert against["distance_m"] > gap + 30  # round the block, never the wrong way
    for seg in against["segments"]:
        if seg["edge"] == edge.id:  # only ever in the edge's own direction
            first, last = seg["pts"][0], seg["pts"][-1]
            ref = LineString(edge.pts)
            assert ref.project(Point(first)) <= ref.project(Point(last))
    on_foot = await route(p70, p30, "foot")
    assert on_foot["distance_m"] == pytest.approx(gap, abs=1)
    assert not any(s["oneway"] for s in on_foot["segments"])
    assert any(s["oneway"] for s in with_flow["segments"])


async def test_road_positions_round_trip(client: httpx.AsyncClient):
    x, z = world(11.5704, 104.9205)
    snapped = await client.get("/roads/snap", params={"x": x, "z": z, "mode": "motorbike"})
    assert snapped.status_code == 200, snapped.text
    s = snapped.json()
    assert s["distance_m"] < 60 and s["modes_forward"] | s["modes_backward"] & MOTORBIKE
    back = await client.get(
        "/roads/position", params={"edge": s["edge_id"], "along_m": s["along_m"]}
    )
    assert (back.json()["x"], back.json()["z"]) == pytest.approx((s["x"], s["z"]), abs=0.02)
    info = (await client.get("/transport/info")).json()
    assert {m["mode"] for m in info["modes"]} == {"foot", "bicycle", "motorbike"}
    assert info["bits"]["motorbike"] == MOTORBIKE


async def test_imports_are_stamped_so_upgrades_rebuild_derived_data():
    """`import_osm.py --if-empty` (Docker, E2E) re-imports when the stored world data came from
    an older importer: a database migrated to Phase 5 gets its road graph."""
    from app.geography.importer import IMPORTER_VERSION

    async with SessionLocal() as session:
        versions = (
            await session.scalars(
                text("""SELECT (stats->>'importer_version')::int FROM dataset_imports
                        WHERE region_id IS NOT NULL""")
            )
        ).all()
    assert versions and all(v == IMPORTER_VERSION for v in versions)
