"""Shared state of enterable buildings: doors, windows, light switches and appliances.

Every client builds the same interiors (generated from the OSM footprint, or the model house),
so a door is named by its building and its own id: ("osm:308", "door:front"). The room keeps
what players changed, in memory, while anyone is in it (a door left open stays open for whoever
comes by later); when the last player leaves, everything is back to its default state, which
every client knows. Players change things only in a building they are at, and the change goes
to everyone around them.
"""

from __future__ import annotations

import math
import re
from collections import OrderedDict

from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry

# Generated interiors: "osm:<building id>" (the id in the chunk payload, buildings.id).
OSM_BUILDING = re.compile(r"^osm:(\d{1,15})$")
# Model buildings (frontend/src/lib/game/buildings/placements.ts PLACEMENTS): id -> centre x, z
# and the radius of their footprint (m).
MODEL_BUILDINGS: dict[str, tuple[float, float, float]] = {
    "riverside-house": (1005.0, -70.0, 9.0),
}
# The System Office, where players register a work role (the client's placements.ts
# SYSTEM_OFFICE_ID: keep the two in step).
SYSTEM_OFFICE = "osm:1518"
# A player changes things in a building they are in or at its door (generous: positions on the
# server trail the client by up to a tenth of a second).
REACH_M = 15.0
MAX_KEYS_PER_BUILDING = 64
MAX_BUILDINGS_PER_ROOM = 4000


class BuildingStates:
    """What players changed, per building: {"door:front": True, "light:living": False, ...}.
    The least recently changed buildings are forgotten first beyond MAX_BUILDINGS_PER_ROOM."""

    def __init__(self) -> None:
        self._states: OrderedDict[str, dict[str, bool]] = OrderedDict()

    def get(self, building: str) -> dict[str, bool]:
        return dict(self._states.get(building, {}))

    def set(self, building: str, key: str, on: bool) -> bool:
        state = self._states.get(building)
        if state is None:
            state = self._states[building] = {}
            while len(self._states) > MAX_BUILDINGS_PER_ROOM:
                self._states.popitem(last=False)
        elif key not in state and len(state) >= MAX_KEYS_PER_BUILDING:
            return False
        state[key] = on
        self._states.move_to_end(building)
        return True

    def clear(self) -> None:
        self._states.clear()

    def __len__(self) -> int:
        return len(self._states)


def building_near(
    building: str, x: float, z: float, footprints: dict[int, BaseGeometry], reach: float = REACH_M
) -> bool:
    """Is (x, z) within `reach` of the building? False for buildings this region does not have."""
    match = OSM_BUILDING.match(building)
    if match:
        footprint = footprints.get(int(match.group(1)))
        return footprint is not None and footprint.distance(Point(x, z)) <= reach
    model = MODEL_BUILDINGS.get(building)
    if model is None:
        return False
    cx, cz, radius = model
    return math.hypot(x - cx, z - cz) <= radius + reach
