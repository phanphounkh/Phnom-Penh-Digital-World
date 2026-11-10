"""Parked vehicles held by the world hub: a cell index shared by every room of a region.

Parked vehicles are world objects: they stay where they were left, also while the owner is
offline. Other players see them only if the owner is visible in the world and neither has
blocked the other, and never with the owner's identity (`mine` is set for the owner only).
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.geography.projection import default_projection


@dataclass(eq=False)
class ParkedVehicle:
    id: str
    owner_id: uuid.UUID
    kind: str
    color: str
    name: str
    x: float
    z: float
    yaw: float
    owner_visible: bool
    odometer_m: float = 0.0
    version: int = 0
    cell: tuple[int, int] = (0, 0)

    def card(self, viewer: uuid.UUID) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "k": self.kind,
            "c": self.color,
            "x": round(self.x, 2),
            "z": round(self.z, 2),
            "yaw": round(self.yaw, 3),
        }
        if viewer == self.owner_id:
            out["mine"] = True
            out["name"] = self.name
        return out

    def ride_card(self) -> dict[str, Any]:
        """What other players see while it is being ridden (kind and colour only)."""
        return {"id": self.id, "k": self.kind, "c": self.color}


@dataclass(eq=False)
class ParkedIndex:
    by_id: dict[str, ParkedVehicle] = field(default_factory=dict)
    cells: dict[tuple[int, int], set[str]] = field(default_factory=dict)

    def add(self, v: ParkedVehicle) -> None:
        self.remove(v.id)
        v.cell = default_projection().chunk_of(v.x, v.z)
        v.version += 1
        self.by_id[v.id] = v
        self.cells.setdefault(v.cell, set()).add(v.id)

    def remove(self, vid: str) -> ParkedVehicle | None:
        v = self.by_id.pop(vid, None)
        if v is not None:
            self.cells.get(v.cell, set()).discard(vid)
        return v

    def around(self, cell: tuple[int, int]) -> list[ParkedVehicle]:
        ix, iz = cell
        out: list[ParkedVehicle] = []
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for vid in self.cells.get((ix + dx, iz + dz), ()):
                    v = self.by_id.get(vid)
                    if v is not None:
                        out.append(v)
        return out

    def near(self, x: float, z: float, radius: float) -> list[ParkedVehicle]:
        cell = default_projection().chunk_of(x, z)
        return [v for v in self.around(cell) if math.hypot(v.x - x, v.z - z) <= radius]

    def of_owner(self, owner_id: uuid.UUID) -> list[ParkedVehicle]:
        return [v for v in self.by_id.values() if v.owner_id == owner_id]
