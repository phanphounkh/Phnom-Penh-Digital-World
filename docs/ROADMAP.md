# Roadmap

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation: accounts, verification, roles, avatars, real map, one playable neighbourhood | **✅ Done (this build)** |
| 2 | 3D city quality | Next |
| 3 | Multiplayer | Planned |
| 4 | Marketplace (shop claims, storefronts, cart, demo checkout) | Planned |
| 5 | Transportation (bicycle, motorbike, car, tuk-tuk, routing) | Planned |
| 6 | Delivery (simulated jobs, tracking) | Planned |
| 7 | Demo wallet and double-entry ledger | Planned |
| 8 | Optimisation and production readiness | Planned |

The first playable MVP (PRD, Part 17) is reached at the end of Phase 6 with a simulated
delivery. Phases 3 and 4 can overlap.

## Phase 2: next tasks

1. **Landmark models**: Blender models for Phsar Thmei (dome and four wings) and Wat Phnom
   (stupa and vihara on a hill), placed by OSM id, replacing the plain extrusions.
2. **Terrain**: a heightfield for Wat Phnom's hill (from an open DEM with documented accuracy)
   and the river embankment.
3. **Street furniture GLBs**: tropical street trees (tamarind, mahogany), Phnom Penh lamp
   posts, signs and roadside stalls, all instanced. Replace the primitive trees and lamps.
4. **Facades**: shophouse ground floors (roller shutters, signage), balconies, AC units, and
   texture atlases by building type.
5. **Day/night cycle** with lit street lamps; weather later.
6. **Interiors**: enter buildings. The `/mall` food court becomes the first shop interior template.
7. **Performance**: measure on real mid-range hardware; GLB compression (meshopt/Draco; the
   avatar is 658 KB unpacked); optional BVH for camera rays; LOD for distant chunks.
8. **Khmer UI** translation (with native review), and a mobile layout pass.

## Phase 3 design notes (multiplayer)

* WebSocket `/ws` through the same origin, authenticated by the session cookie. Every message
  is validated server-side (speed limits against the projected road network and bounds).
* Interest management by chunk: a player subscribes to its own and neighbouring chunks.
  Positions are sent at 10 Hz with client prediction and remote interpolation.
* Redis for presence, room fan-out across API workers and shared rate limits.
* Visibility honours `user_profiles.world_visible`. Hidden players are never broadcast.
* Chat with rate limits, mute, block and report (`player_reports`), plus moderation queues.
