"""Travel modes and vehicle types: the single source of truth for speeds and sizes.

Mirrored by the web client in `frontend/src/lib/game/vehicles/specs.ts` (a shared fixture test
keeps the two in step). Speeds are game values for a dense city centre, chosen to feel right
in Daun Penh; they are not legal limits. Road speed limits from OSM `maxspeed` are shown to the
rider and used for travel-time estimates, never enforced.
"""

from __future__ import annotations

from dataclasses import dataclass

# Mode bits used in road access masks (road_edges.access_fwd / access_bwd, chunk payloads).
FOOT = 1
BICYCLE = 2
MOTORBIKE = 4
CAR = 8  # reserved for cars and tuk-tuks (not rideable yet)
ALL_MODES = FOOT | BICYCLE | MOTORBIKE | CAR
VEHICLE_MODES = BICYCLE | MOTORBIKE | CAR


@dataclass(frozen=True)
class ModeSpec:
    mode: str
    bit: int
    label: str
    label_km: str
    top_speed: float  # m/s, the fastest the client moves in this mode
    cruise_speed: float  # m/s, used for route time estimates
    radius: float  # collision radius on the client (m)
    parking_spacing: float = 0.0  # minimum distance between parked vehicles (m)


MODES: dict[str, ModeSpec] = {
    "foot": ModeSpec("foot", FOOT, "On foot", "ដើរ", 6.5, 2.6, 0.35),
    "bicycle": ModeSpec("bicycle", BICYCLE, "Bicycle", "កង់", 7.0, 5.5, 0.42, 1.0),
    "motorbike": ModeSpec("motorbike", MOTORBIKE, "Motorbike", "ម៉ូតូ", 12.5, 10.0, 0.5, 1.3),
}
VEHICLE_KINDS = ("bicycle", "motorbike")

# The server accepts a move if it is within this factor of the mode's top speed (network
# jitter and batching), plus a fixed slack in metres (see app/multiplayer/validation.py).
SPEED_TOLERANCE = 1.35

# How close the rider must stand to mount their vehicle (m).
MOUNT_RANGE_M = 3.0
# Riding is allowed on the carriageway and the pavement beside it: the rendered pavement is
# 1.6 m wide on each side (frontend chunkGeometry.ts), the client stops riders 2.0 m beyond the
# carriageway edge, the server tolerates 2.75 m (so honest clients are never corrected).
RIDE_MARGIN_CLIENT_M = 2.0
RIDE_MARGIN_SERVER_M = 2.75
# Parking: at the kerb (the outer KERB_BAND_M of the carriageway) or on the pavement of a
# vehicle road, anywhere on service roads (alleys, parking aisles) and in OSM car parks;
# never in the middle of a through road.
KERB_BAND_M = 2.2
# A rider who asks to park searches this far for a legal spot (pulling over to the kerb).
PULL_OVER_M = 6.0
SUMMON_COOLDOWN_S = 60


def mode_spec(mode: str) -> ModeSpec:
    return MODES[mode]


def server_speed_limit(mode: str) -> float:
    return MODES[mode].top_speed * SPEED_TOLERANCE


def as_fixture() -> dict[str, object]:
    """Values the client mirrors (tests/fixtures + frontend specs.test.ts)."""
    return {
        "bits": {"foot": FOOT, "bicycle": BICYCLE, "motorbike": MOTORBIKE, "car": CAR},
        "modes": {
            m.mode: {
                "top_speed": m.top_speed,
                "cruise_speed": m.cruise_speed,
                "radius": m.radius,
                "parking_spacing": m.parking_spacing,
            }
            for m in MODES.values()
        },
        "mount_range_m": MOUNT_RANGE_M,
        "ride_margin_client_m": RIDE_MARGIN_CLIENT_M,
        "kerb_band_m": KERB_BAND_M,
        "pull_over_m": PULL_OVER_M,
    }
