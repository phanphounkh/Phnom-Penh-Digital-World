"""Conversions between geographic coordinates (WGS84) and 3D world coordinates.

The world is a local frame on UTM zone 48N (EPSG:32648), the metric projection that covers
Phnom Penh. Latitude/longitude are never treated as metres:

    x =   easting  - origin_easting      (metres, east positive)
    z = -(northing - origin_northing)    (metres, north is -Z, the Three.js "forward")
    y = height above ground              (metres)

UTM scale distortion at this longitude is ~0.9996-0.9997, i.e. well under 0.1 % across the
city, which is acceptable for a walkable world. Geodesic distances use the WGS84 ellipsoid.
"""

from dataclasses import dataclass, field
from functools import lru_cache
from math import floor

import numpy as np
import shapely
from pyproj import Geod, Transformer
from shapely.geometry.base import BaseGeometry

from app.geography.regions import CHUNK_SIZE_M, WORLD_CRS, WORLD_ORIGIN

WGS84 = "EPSG:4326"
_GEOD = Geod(ellps="WGS84")


@dataclass(frozen=True)
class WorldProjection:
    origin_lat: float
    origin_lon: float
    chunk_size: float = CHUNK_SIZE_M
    crs: str = WORLD_CRS
    _fwd: Transformer = field(init=False, repr=False, compare=False)
    _inv: Transformer = field(init=False, repr=False, compare=False)
    origin_easting: float = field(init=False)
    origin_northing: float = field(init=False)

    def __post_init__(self) -> None:
        fwd = Transformer.from_crs(WGS84, self.crs, always_xy=True)
        inv = Transformer.from_crs(self.crs, WGS84, always_xy=True)
        e, n = fwd.transform(self.origin_lon, self.origin_lat)
        object.__setattr__(self, "_fwd", fwd)
        object.__setattr__(self, "_inv", inv)
        object.__setattr__(self, "origin_easting", e)
        object.__setattr__(self, "origin_northing", n)

    # ── points ──────────────────────────────────────────────────────────────────────────
    def to_world(self, lat: float, lon: float) -> tuple[float, float]:
        e, n = self._fwd.transform(lon, lat)
        return e - self.origin_easting, -(n - self.origin_northing)

    def to_latlon(self, x: float, z: float) -> tuple[float, float]:
        lon, lat = self._inv.transform(x + self.origin_easting, self.origin_northing - z)
        return lat, lon

    # ── geometries (shapely, lon/lat axis order in, x/z out; vectorised) ─────────────────
    def geometry_to_world(self, geom: BaseGeometry) -> BaseGeometry:
        def fn(coords: np.ndarray) -> np.ndarray:
            e, n = self._fwd.transform(coords[:, 0], coords[:, 1])
            return np.column_stack([e - self.origin_easting, self.origin_northing - n])

        return shapely.transform(geom, fn)

    def geometry_to_lonlat(self, geom: BaseGeometry) -> BaseGeometry:
        def fn(coords: np.ndarray) -> np.ndarray:
            lon, lat = self._inv.transform(
                coords[:, 0] + self.origin_easting, self.origin_northing - coords[:, 1]
            )
            return np.column_stack([lon, lat])

        return shapely.transform(geom, fn)

    # ── chunks ──────────────────────────────────────────────────────────────────────────
    def chunk_of(self, x: float, z: float) -> tuple[int, int]:
        return floor(x / self.chunk_size), floor(z / self.chunk_size)

    def chunk_bounds(self, ix: int, iz: int) -> tuple[float, float, float, float]:
        """(min_x, min_z, max_x, max_z) of a chunk in world metres."""
        s = self.chunk_size
        return ix * s, iz * s, (ix + 1) * s, (iz + 1) * s


def chunk_key(ix: int, iz: int) -> str:
    return f"{ix}_{iz}"


def parse_chunk_key(key: str) -> tuple[int, int]:
    a, b = key.split("_")
    return int(a), int(b)


def geodesic_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Ellipsoidal (WGS84) distance in metres."""
    _, _, dist = _GEOD.inv(lon1, lat1, lon2, lat2)
    return float(dist)


@lru_cache
def default_projection() -> WorldProjection:
    return WorldProjection(WORLD_ORIGIN["lat"], WORLD_ORIGIN["lon"])
