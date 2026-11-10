"""Where vehicles may ride and park (server side, world metres).

* **Riding**: a vehicle must stay on a road its mode may use: within the carriageway plus the
  pavement beside it (`RIDE_MARGIN_SERVER_M` beyond the edge), or inside an OSM car park.
  The client applies the same rule with a smaller margin, so honest riders are never
  corrected (frontend `RoadNetwork.ts`).
* **Parking**: on that ride area, but not in the middle of a through road: only at the kerb
  (the outer `KERB_BAND_M` of the carriageway) or on the pavement; anywhere on service roads
  and in car parks; never inside a building or water; not on top of another parked vehicle.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from shapely import wkb
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.geography.projection import default_projection
from app.transport.network import THROUGH_CLASSES
from app.transport.specs import KERB_BAND_M, RIDE_MARGIN_SERVER_M, VEHICLE_MODES


@dataclass(frozen=True)
class RoadStrip:
    """A drivable stretch: world centreline, carriageway width, class, allowed modes."""

    line: LineString
    width_m: float
    highway: str
    modes: int  # union of both directions


class TravelArea:
    def __init__(
        self,
        strips: Iterable[RoadStrip],
        parking: Iterable[Polygon] = (),
        margin: float = RIDE_MARGIN_SERVER_M,
    ):
        self.strips = list(strips)
        self.corridors = [s.line.buffer(s.width_m / 2 + margin, quad_segs=4) for s in self.strips]
        self.tree = STRtree(self.corridors) if self.corridors else None
        # The middle of through roads (no parking there).
        cores = [
            (s, s.line.buffer(max(0.4, s.width_m / 2 - KERB_BAND_M), quad_segs=4))
            for s in self.strips
            if s.highway in THROUGH_CLASSES and s.width_m / 2 - KERB_BAND_M > 0.4
        ]
        self.core_strips = [s for s, _ in cores]
        self.cores = [c for _, c in cores]
        self.core_tree = STRtree(self.cores) if self.cores else None
        self.parking = [p for p in parking if p.is_valid and not p.is_empty]
        self.parking_tree = STRtree(self.parking) if self.parking else None

    def in_parking_area(self, x: float, z: float) -> bool:
        if self.parking_tree is None:
            return False
        return bool(len(self.parking_tree.query(Point(x, z), predicate="intersects")))

    def allows(self, bit: int, x: float, z: float) -> bool:
        """May a vehicle of this mode be at (x, z)?"""
        if self.in_parking_area(x, z):
            return True
        if self.tree is None:
            return False
        for i in self.tree.query(Point(x, z), predicate="intersects"):
            if self.strips[int(i)].modes & bit:
                return True
        return False

    def in_carriageway_core(self, x: float, z: float) -> bool:
        if self.core_tree is None:
            return False
        return bool(len(self.core_tree.query(Point(x, z), predicate="intersects")))

    def parkable(self, bit: int, x: float, z: float) -> bool:
        if self.in_parking_area(x, z):
            return True
        return self.allows(bit, x, z) and not self.in_carriageway_core(x, z)

    def kerb_line(self, bit: int, x: float, z: float) -> tuple[float, float, float] | None:
        """Tidy a parking spot: on the road under (x, z), the point on the same side just
        inside the kerb (0.6 m from the carriageway edge) and the road's direction there (yaw).
        None off-road, on narrow lanes (they are parked down the middle) or in car parks."""
        if self.tree is None or self.in_parking_area(x, z):
            return None
        p = Point(x, z)
        best: tuple[float, RoadStrip] | None = None
        for i in self.tree.query(p, predicate="intersects"):
            strip = self.strips[int(i)]
            if strip.modes & bit and strip.width_m >= 5.0:
                d = strip.line.distance(p)
                if best is None or d < best[0]:
                    best = (d, strip)
        if best is None:
            return None
        line = best[1].line
        along = line.project(p)
        c = line.interpolate(along)
        a = line.interpolate(max(0.0, along - 0.5))
        b = line.interpolate(min(line.length, along + 0.5))
        dx, dz = b.x - a.x, b.y - a.y
        length = math.hypot(dx, dz) or 1.0
        dx, dz = dx / length, dz / length
        side = 1.0 if (x - c.x) * -dz + (z - c.y) * dx >= 0 else -1.0  # right of the line: +1
        offset = best[1].width_m / 2 - 0.6
        return c.x - dz * offset * side, c.y + dx * offset * side, math.atan2(dx, dz)

    def nearest_parkable(
        self,
        bit: int,
        x: float,
        z: float,
        max_distance: float,
        free: Callable[[float, float], bool],
        step: float = 0.75,
    ) -> tuple[float, float] | None:
        """The closest legal spot within `max_distance` (rings of candidates), or None.
        `free(x, z)` adds the caller's checks (buildings, other parked vehicles)."""
        if self.parkable(bit, x, z) and free(x, z):
            return x, z
        rings = max(1, int(max_distance / step))
        for ring in range(1, rings + 1):
            radius = ring * step
            count = max(8, int(2 * math.pi * radius / step))
            best: tuple[float, float] | None = None
            for k in range(count):
                a = 2 * math.pi * k / count
                cx, cz = x + radius * math.cos(a), z + radius * math.sin(a)
                if self.parkable(bit, cx, cz) and free(cx, cz):
                    best = (cx, cz)
                    break
            if best is not None:
                return best
        return None


async def load_travel_area(session: AsyncSession, region_id: uuid.UUID) -> TravelArea:
    """The region's ride/park area from its road edges and OSM car parks (world metres)."""
    projection = default_projection()
    strips = [
        RoadStrip(LineString(row.pts), row.width_m, row.highway, row.access_fwd | row.access_bwd)
        for row in await session.execute(
            text("""SELECT pts, width_m, highway, access_fwd, access_bwd FROM road_edges
                    WHERE region_id = :r AND (access_fwd | access_bwd) & :vehicles > 0"""),
            {"r": region_id, "vehicles": VEHICLE_MODES},
        )
    ]
    parking: list[Polygon] = []
    for row in await session.execute(
        text("""SELECT ST_AsBinary(geom) AS g FROM land_areas
                WHERE region_id = :r AND kind = 'parking'"""),
        {"r": region_id},
    ):
        geom = projection.geometry_to_world(wkb.loads(bytes(row.g)))
        parking.extend(g for g in getattr(geom, "geoms", [geom]) if isinstance(g, Polygon))
    return TravelArea(strips, parking)
