"""Routing on the road graph (road_nodes / road_edges), in memory per region.

* `snap(x, z, mode)` — world position → nearest road position the mode may use
  (edge, metres along it, the point on the centreline, street name).
* `point_at(edge, along)` — road position → world position and heading.
* `route(from, to, mode)` — fastest path (A*, travel time with per-mode speeds, OSM speed
  limits where tagged, a short wait at traffic signals). One-way streets bind vehicles, not
  pedestrians. The result carries the path, per-edge widths (so the client can drive in the
  right-hand lane), and turn-by-turn steps with English and Khmer street names.
"""

from __future__ import annotations

import heapq
import itertools
import math
import uuid
from dataclasses import dataclass, field
from typing import Any

from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.transport.network import bearing_deg, speed_kmh
from app.transport.specs import FOOT, MODES, MOTORBIKE

SIGNAL_WAIT_S = 6.0
SNAP_RADIUS_M = 250.0


@dataclass
class Edge:
    id: int
    road_id: int
    a: int
    b: int
    pts: list[tuple[float, float]]
    cum: list[float]
    length: float
    highway: str
    width: float
    fwd: int
    bwd: int
    max_speed_kmh: int | None
    name: str | None
    name_en: str | None
    name_km: str | None
    line: LineString = field(repr=False)

    @property
    def street(self) -> str | None:
        return self.name_en or self.name


@dataclass
class Snap:
    edge: int  # index into RoadGraph.edges
    along: float
    x: float
    z: float
    distance: float


@dataclass
class Traversal:
    edge: int
    forward: bool
    start: float  # metres along the edge (in edge coordinates)
    end: float


def _cumulative(pts: list[tuple[float, float]]) -> list[float]:
    out = [0.0]
    for (ax, az), (bx, bz) in itertools.pairwise(pts):
        out.append(out[-1] + math.hypot(bx - ax, bz - az))
    return out


def _turn(delta: float) -> str:
    a = abs(delta)
    side = "right" if delta > 0 else "left"
    if a < 25:
        return "straight"
    if a < 60:
        return f"slight_{side}"
    if a < 140:
        return side
    if a < 170:
        return f"sharp_{side}"
    return "uturn"


class RoadGraph:
    def __init__(self, nodes: dict[int, tuple[float, float, bool]], edges: list[Edge]):
        self.nodes = nodes
        self.edges = edges
        self.adj: dict[int, list[tuple[int, bool]]] = {n: [] for n in nodes}
        for i, e in enumerate(edges):
            self.adj.setdefault(e.a, []).append((i, True))
            self.adj.setdefault(e.b, []).append((i, False))
        self.tree = STRtree([e.line for e in edges]) if edges else None
        self.by_id = {e.id: i for i, e in enumerate(edges)}

    # ── positions ─────────────────────────────────────────────────────────────────────
    def point_at(self, index: int, along: float) -> tuple[float, float, float]:
        """World x, z and compass bearing (along the edge's direction) at `along` metres."""
        e = self.edges[index]
        along = min(max(along, 0.0), e.length)
        for i in range(1, len(e.pts)):
            if e.cum[i] >= along or i == len(e.pts) - 1:
                (ax, az), (bx, bz) = e.pts[i - 1], e.pts[i]
                seg = e.cum[i] - e.cum[i - 1] or 1.0
                k = min(1.0, max(0.0, (along - e.cum[i - 1]) / seg))
                return ax + (bx - ax) * k, az + (bz - az) * k, bearing_deg(ax, az, bx, bz)
        x, z = e.pts[-1]
        return x, z, 0.0

    def usable(self, e: Edge, bit: int) -> bool:
        return bool((e.fwd | e.bwd) & bit)

    def snap(self, x: float, z: float, bit: int, k: int = 6) -> list[Snap]:
        """The `k` nearest road positions usable by the mode (closest first)."""
        if self.tree is None:
            return []
        p = Point(x, z)
        found: list[Snap] = []
        for radius in (30.0, 80.0, SNAP_RADIUS_M):
            idx = self.tree.query(p.buffer(radius))
            found = []
            for i in idx:
                e = self.edges[int(i)]
                if not self.usable(e, bit):
                    continue
                along = e.line.project(p)
                q = e.line.interpolate(along)
                found.append(Snap(int(i), along, q.x, q.y, q.distance(p)))
            if len(found) >= 1:
                break
        found.sort(key=lambda s: s.distance)
        return found[:k]

    # ── routing ───────────────────────────────────────────────────────────────────────
    def speed(self, e: Edge, mode: str) -> float:
        spec = MODES[mode]
        if spec.bit & MOTORBIKE:
            return min(spec.cruise_speed, speed_kmh(e.highway, e.max_speed_kmh) / 3.6)
        return spec.cruise_speed

    def _route_from(
        self, start: Snap, goal: Snap, mode: str
    ) -> tuple[float, list[Traversal]] | None:
        bit = MODES[mode].bit
        top = max(MODES[mode].cruise_speed, 1.0)
        se, ge = self.edges[start.edge], self.edges[goal.edge]
        best: tuple[float, list[Traversal]] | None = None
        # Same edge: drive straight along it if the direction is allowed.
        if start.edge == goal.edge:
            if goal.along >= start.along and se.fwd & bit:
                cost = (goal.along - start.along) / self.speed(se, mode)
                best = (cost, [Traversal(start.edge, True, start.along, goal.along)])
            elif goal.along < start.along and se.bwd & bit:
                cost = (start.along - goal.along) / self.speed(se, mode)
                best = (cost, [Traversal(start.edge, False, start.along, goal.along)])
        # Goal: reach one end of the goal edge, then drive to the goal point.
        finish: dict[int, tuple[float, Traversal]] = {}
        if ge.fwd & bit:
            finish[ge.a] = (
                goal.along / self.speed(ge, mode),
                Traversal(goal.edge, True, 0, goal.along),
            )
        if ge.bwd & bit:
            t = Traversal(goal.edge, False, ge.length, goal.along)
            cost = (ge.length - goal.along) / self.speed(ge, mode)
            if ge.b not in finish or cost < finish[ge.b][0]:
                finish[ge.b] = (cost, t)

        def h(node: int) -> float:
            nx, nz, _ = self.nodes[node]
            return math.hypot(nx - goal.x, nz - goal.z) / top

        dist: dict[int, float] = {}
        prev: dict[int, tuple[int | None, Traversal]] = {}
        heap: list[tuple[float, float, int]] = []
        if se.fwd & bit:
            c = (se.length - start.along) / self.speed(se, mode)
            dist[se.b] = c
            prev[se.b] = (None, Traversal(start.edge, True, start.along, se.length))
        if se.bwd & bit:
            c = start.along / self.speed(se, mode)
            if se.a not in dist or c < dist[se.a]:
                dist[se.a] = c
                prev[se.a] = (None, Traversal(start.edge, False, start.along, 0))
        for n, c in dist.items():
            heapq.heappush(heap, (c + h(n), c, n))
        done: set[int] = set()
        while heap:
            f, cost, node = heapq.heappop(heap)
            if node in done or cost > dist.get(node, math.inf):
                continue
            if best is not None and f >= best[0]:
                break
            done.add(node)
            if node in finish:
                total = cost + finish[node][0]
                if best is None or total < best[0]:
                    path = [finish[node][1]]
                    cur: int | None = node
                    while cur is not None:
                        parent, trav = prev[cur]
                        path.append(trav)
                        cur = parent
                    best = (total, path[::-1])
            # Vehicles wait at traffic signals; pedestrians are not routed around them.
            wait = SIGNAL_WAIT_S if self.nodes[node][2] and bit != FOOT else 0.0
            for i, forward in self.adj.get(node, []):
                e = self.edges[i]
                if not ((e.fwd if forward else e.bwd) & bit):
                    continue
                nxt = e.b if forward else e.a
                c = cost + wait + e.length / self.speed(e, mode)
                if c < dist.get(nxt, math.inf):
                    dist[nxt] = c
                    prev[nxt] = (
                        node,
                        Traversal(
                            i, forward, 0 if forward else e.length, e.length if forward else 0
                        ),
                    )
                    heapq.heappush(heap, (c + h(nxt), c, nxt))
        return best

    def route(self, sx: float, sz: float, tx: float, tz: float, mode: str) -> dict[str, Any] | None:
        bit = MODES[mode].bit
        starts, goals = self.snap(sx, sz, bit), self.snap(tx, tz, bit)
        best: tuple[float, list[Traversal], Snap, Snap] | None = None
        # Try a few nearby roads at each end, so a dead-end fragment never blocks a route.
        for s in starts[:4]:
            for g in goals[:4]:
                found = self._route_from(s, g, mode)
                if found is None:
                    continue
                # Prefer close snaps: walking to the road costs time too.
                score = found[0] + (s.distance + g.distance) / MODES["foot"].cruise_speed
                if best is None or score < best[0]:
                    best = (score, found[1], s, g)
            if best is not None and s.distance > 2 * starts[0].distance + 20:
                break
        if best is None:
            return None
        _, path, s, g = best
        return self.describe(path, s, g, mode)

    # ── output ────────────────────────────────────────────────────────────────────────
    def _slice(self, t: Traversal) -> list[tuple[float, float]]:
        e = self.edges[t.edge]
        lo, hi = sorted((t.start, t.end))
        pts = [self.point_at(t.edge, lo)[:2]]
        pts += [p for p, c in zip(e.pts, e.cum, strict=True) if lo < c < hi]
        pts.append(self.point_at(t.edge, hi)[:2])
        return pts if t.forward else pts[::-1]

    def describe(self, path: list[Traversal], s: Snap, g: Snap, mode: str) -> dict[str, Any]:
        bit = MODES[mode].bit
        segments: list[dict[str, Any]] = []
        points: list[list[float]] = []
        duration = 0.0
        distance = 0.0
        for t in path:
            e = self.edges[t.edge]
            pts = [(round(x, 2), round(z, 2)) for x, z in self._slice(t)]
            length = abs(t.end - t.start)
            if length < 0.01:
                continue
            distance += length
            duration += length / self.speed(e, mode)
            for p in pts:
                if not points or math.hypot(p[0] - points[-1][0], p[1] - points[-1][1]) > 0.01:
                    points.append([p[0], p[1]])
            against = e.bwd if t.forward else e.fwd
            segments.append(
                {
                    "edge": e.id,
                    "pts": [list(p) for p in pts],
                    "length_m": round(length, 1),
                    "w": e.width,
                    "cls": e.highway,
                    # True when traffic of this mode cannot come the other way (keep right
                    # anyway, but the whole carriageway flows with you).
                    "oneway": not (against & bit) and bit != MODES["foot"].bit,
                    "street": e.street,
                    "street_km": e.name_km,
                    "speed_kmh": e.max_speed_kmh,
                }
            )
        steps = self._steps(segments)
        return {
            "mode": mode,
            "distance_m": round(distance, 1),
            "duration_s": round(duration),
            "from": {"x": round(s.x, 2), "z": round(s.z, 2), "off_road_m": round(s.distance, 1)},
            "to": {"x": round(g.x, 2), "z": round(g.z, 2), "off_road_m": round(g.distance, 1)},
            "points": points,
            "segments": segments,
            "steps": steps,
        }

    @staticmethod
    def _steps(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Turn-by-turn steps. Turns are measured over a 15 m baseline either side of the
        junction (not the last few centimetres of geometry), and very short legs between two
        junctions are folded into one manoeuvre, so a dual-named junction reads as one turn."""
        if not segments:
            return []
        path: list[tuple[float, float]] = []
        cum: list[float] = []
        junctions: list[tuple[int, float]] = []  # (segment index, distance along the path)
        for i, seg in enumerate(segments):
            if i:
                junctions.append((i, cum[-1]))
            for x, z in seg["pts"]:
                if path and math.hypot(x - path[-1][0], z - path[-1][1]) < 0.01:
                    continue
                cum.append(cum[-1] + math.hypot(x - path[-1][0], z - path[-1][1]) if path else 0.0)
                path.append((x, z))
        total = cum[-1]

        def at(d: float) -> tuple[float, float]:
            d = min(max(d, 0.0), total)
            for k in range(1, len(path)):
                if cum[k] >= d:
                    span = cum[k] - cum[k - 1] or 1.0
                    t = (d - cum[k - 1]) / span
                    (ax, az), (bx, bz) = path[k - 1], path[k]
                    return ax + (bx - ax) * t, az + (bz - az) * t
            return path[-1]

        def heading(d0: float, d1: float) -> float:
            (ax, az), (bx, bz) = at(d0), at(d1)
            return bearing_deg(ax, az, bx, bz)

        def step(kind: str, seg: dict[str, Any], d: float, bearing: float) -> dict[str, Any]:
            x, z = at(d)
            return {
                "type": kind,
                "street": seg["street"],
                "street_km": seg["street_km"],
                "bearing": round(bearing),
                "x": round(x, 2),
                "z": round(z, 2),
                "at_m": d,
            }

        base = 15.0
        steps = [step("depart", segments[0], 0.0, heading(0.0, min(base, total)))]
        for i, d in junctions:
            seg, prev = segments[i], segments[i - 1]
            delta = (heading(d, d + base) - heading(d - base, d) + 540) % 360 - 180
            kind = _turn(delta)
            renamed = seg["street"] != prev["street"] and seg["street"] is not None
            if kind == "straight" and not renamed:
                continue
            candidate = step(
                "continue" if kind == "straight" else kind, seg, d, heading(d, d + base)
            )
            last = steps[-1]
            if last["type"] != "depart" and d - last["at_m"] < 12.0:
                # Two junctions a few metres apart: one manoeuvre, measured across both.
                d0 = last["at_m"]
                merged = _turn((heading(d, d + base) - heading(d0 - base, d0) + 540) % 360 - 180)
                if merged == "straight" and seg["street"] == steps[-2]["street"]:
                    steps.pop()
                    continue
                candidate["type"] = "continue" if merged == "straight" else merged
                candidate["x"], candidate["z"] = last["x"], last["z"]
                candidate["at_m"] = d0
                steps[-1] = candidate
                continue
            steps.append(candidate)
        end = segments[-1]
        steps.append(step("arrive", end, total, heading(max(0.0, total - base), total)))
        for k, st in enumerate(steps):
            nxt = steps[k + 1]["at_m"] if k + 1 < len(steps) else st["at_m"]
            st["distance_m"] = round(nxt - st["at_m"], 1)
            st["at_m"] = round(st["at_m"], 1)
        return steps


# ── loading (cached per region; the importer invalidates) ─────────────────────────────────
_graphs: dict[uuid.UUID, RoadGraph] = {}


def invalidate() -> None:
    _graphs.clear()


async def load_graph(session: AsyncSession, region_id: uuid.UUID) -> RoadGraph:
    cached = _graphs.get(region_id)
    if cached is not None:
        return cached
    nodes = {
        row.id: (row.x, row.z, row.is_signal)
        for row in await session.execute(
            text("SELECT id, x, z, is_signal FROM road_nodes WHERE region_id = :r"),
            {"r": region_id},
        )
    }
    edges: list[Edge] = []
    for row in await session.execute(
        text("""
        SELECT e.id, e.road_id, e.from_node_id, e.to_node_id, e.length_m, e.highway, e.width_m,
               e.access_fwd, e.access_bwd, e.max_speed_kmh, e.pts, r.name, r.name_en, r.name_km
        FROM road_edges e JOIN roads r ON r.id = e.road_id
        WHERE e.region_id = :r ORDER BY e.id"""),
        {"r": region_id},
    ):
        pts = [(float(x), float(z)) for x, z in row.pts]
        cum = _cumulative(pts)
        edges.append(
            Edge(
                id=row.id,
                road_id=row.road_id,
                a=row.from_node_id,
                b=row.to_node_id,
                pts=pts,
                cum=cum,
                length=cum[-1],
                highway=row.highway,
                width=row.width_m,
                fwd=row.access_fwd,
                bwd=row.access_bwd,
                max_speed_kmh=row.max_speed_kmh,
                name=row.name,
                name_en=row.name_en,
                name_km=row.name_km,
                line=LineString(pts),
            )
        )
    graph = RoadGraph(nodes, edges)
    _graphs[region_id] = graph
    return graph
