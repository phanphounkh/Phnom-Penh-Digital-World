"""Server-side movement validation for the authoritative room.

Clients predict their own movement for responsiveness; the server accepts a new position only
if it is reachable (speed), inside the playable region, and not inside a building footprint or
water. Rejected moves are answered with a correction to the last accepted position.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

# Running speed is 6.5 m/s on the client; allow headroom for timing jitter and latency.
MAX_SPEED_MPS = 6.5 * 1.35
SLACK_M = 2.0
# Footprints are shrunk so a player brushing a wall (client collision radius 0.35 m) is fine.
FOOTPRINT_TOLERANCE_M = 0.6


@dataclass
class Verdict:
    ok: bool
    reason: str = ""


class MovementValidator:
    def __init__(self, obstacles: list[Polygon], bounds: tuple[float, float, float, float]):
        shrunk = [p.buffer(-FOOTPRINT_TOLERANCE_M) for p in obstacles]
        self.obstacles = [p for p in shrunk if not p.is_empty]
        self.tree = STRtree(self.obstacles) if self.obstacles else None
        self.bounds = bounds  # min_x, min_z, max_x, max_z
        # Walk-in shop interiors (Phase 4): open floor cut into building footprints.
        self.open_zones: list[Polygon] = []
        self.zone_tree: STRtree | None = None

    def set_open_zones(self, zones: list[Polygon]) -> None:
        self.open_zones = [z for z in zones if z.is_valid and not z.is_empty]
        self.zone_tree = STRtree(self.open_zones) if self.open_zones else None

    def inside_obstacle(self, x: float, z: float) -> bool:
        if self.tree is None:
            return False
        point = Point(x, z)
        if not len(self.tree.query(point, predicate="within")):
            return False
        # Inside a footprint: allowed only on the floor of an open shop unit.
        return self.zone_tree is None or not len(self.zone_tree.query(point, predicate="within"))

    def in_bounds(self, x: float, z: float) -> bool:
        min_x, min_z, max_x, max_z = self.bounds
        return min_x <= x <= max_x and min_z <= z <= max_z

    def check(self, prev_x: float, prev_z: float, x: float, z: float, dt: float) -> Verdict:
        if not self.in_bounds(x, z):
            return Verdict(False, "bounds")
        distance = math.hypot(x - prev_x, z - prev_z)
        if distance > MAX_SPEED_MPS * max(dt, 0.0) + SLACK_M:
            return Verdict(False, "speed")
        if self.inside_obstacle(x, z):
            return Verdict(False, "blocked")
        return Verdict(True)

    def free_spot_near(
        self,
        x: float,
        z: float,
        radius: float = 1.6,
        others: list[tuple[float, float]] | None = None,
        spacing: float = 1.2,
        exact_ok: bool = False,
        start_angle: float = 0.0,
    ) -> tuple[float, float]:
        """A nearby open position: in bounds, outside obstacles and at least `spacing` metres
        from `others` (so players arriving at the same spot do not stand inside each other)."""

        def free(cx: float, cz: float) -> bool:
            return (
                self.in_bounds(cx, cz)
                and not self.inside_obstacle(cx, cz)
                and all(math.hypot(cx - ox, cz - oz) >= spacing for ox, oz in others or [])
            )

        if exact_ok and free(x, z):
            return x, z
        for ring in range(0, 8):
            r = radius + ring * 1.2
            for k in range(8):
                a = start_angle + k / 8 * math.tau
                cx, cz = x + math.cos(a) * r, z + math.sin(a) * r
                if free(cx, cz):
                    return cx, cz
        return x, z
