"""Terrain height in world coordinates (metres above street level).

Mirrored exactly by frontend/src/lib/game/city/terrain.ts; a shared fixture test keeps the
two implementations identical.
"""

from dataclasses import dataclass
from functools import lru_cache
from math import cos, hypot, pi

from app.geography.projection import WorldProjection, default_projection
from app.geography.regions import TERRAIN_FEATURES


@dataclass(frozen=True)
class Mound:
    slug: str
    x: float
    z: float
    height_m: float
    top_radius_m: float
    base_radius_m: float
    source: str

    def height_at(self, x: float, z: float) -> float:
        d = hypot(x - self.x, z - self.z)
        if d <= self.top_radius_m:
            return self.height_m
        if d >= self.base_radius_m:
            return 0.0
        t = (d - self.top_radius_m) / (self.base_radius_m - self.top_radius_m)
        return self.height_m * 0.5 * (1 + cos(pi * t))


def build_mounds(projection: WorldProjection) -> list[Mound]:
    out = []
    for f in TERRAIN_FEATURES:
        x, z = projection.to_world(f["lat"], f["lon"])
        out.append(
            Mound(
                f["slug"],
                round(x, 2),
                round(z, 2),
                f["height_m"],
                f["top_radius_m"],
                f["base_radius_m"],
                f["source"],
            )
        )
    return out


@lru_cache
def default_mounds() -> tuple[Mound, ...]:
    return tuple(build_mounds(default_projection()))


def height_at(x: float, z: float, mounds: tuple[Mound, ...] | list[Mound] | None = None) -> float:
    return max((m.height_at(x, z) for m in (mounds or default_mounds())), default=0.0)
