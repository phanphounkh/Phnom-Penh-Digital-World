"""Buildings with an interior players can walk into.

The client generates a furnished interior for these OpenStreetMap buildings
(frontend/src/lib/game/buildings/placements.ts, ENTERABLE: the same ids) and cuts a door into
their facade; the server lets players on foot stand inside their footprints. The ids are
`buildings.id` (the chunk payloads' building ids); the OSM ways are noted for re-imports.
"""

ENTERABLE_BUILDING_IDS: frozenset[int] = frozenset(
    {
        308,  # way 372811657 - "Riverside Café"
        1683,  # way 1267044712 - "Quay Mini-mart"
        1635,  # way 1094071870 - a house
    }
)
