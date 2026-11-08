# Roadmap

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation: accounts, verification, roles, avatars, real map, one playable neighbourhood | ✅ Done |
| 2 | 3D city quality | ✅ Done |
| 3 | Multiplayer | **✅ Done (this build)** |
| 4 | Marketplace (shop claims, storefronts, cart, demo checkout) | Next |
| 5 | Transportation (bicycle, motorbike, car, tuk-tuk, routing) | Planned |
| 6 | Delivery (simulated jobs, tracking) | Planned |
| 7 | Demo wallet and double-entry ledger | Planned |
| 8 | Optimisation and production readiness | Planned |

The first playable MVP (PRD, Part 17) is reached at the end of Phase 6 with a simulated
delivery. Phases 3 and 4 can overlap.

## Phase 2: delivered

* **Landmarks:** a Blender model of Phsar Thmei's dome on the real X-plan footprint (published
  26 m summit), a Wat Phnom stupa model, procedural tiered Khmer roofs on the vihara and on
  temples, and two OSM duplicate footprints hidden.
* **Terrain:** Wat Phnom's 27 m hill, shared by server and client, with roads, buildings,
  props, player and camera following it.
* **Street furniture:** Blender GLBs (rain tree, ornamental tree, sugar palm, double-arm lamp,
  traffic signal, sign post), Meshopt-compressed and instanced. Trunks and poles collide.
* **Street signs:** 181 bilingual signs at real named intersections.
* **Facades:** shophouse ground floors and night-lit windows via a facade shader.
* **Day/night:** real Phnom Penh solar time or presets; lamps, light pools and windows at night.
* **Performance:** worker-built chunks, cached shadows, detail LOD. A locked 60 fps on an
  Intel ADL-N iGPU (docs/perf).
* **Assets:** Meshopt compression (avatar 643 → 202 KB), a dev-only `/dev/assets` gallery.

## Deferred from Phase 2 (still open)

1. **Interiors:** entering buildings. The `/mall` food court becomes the first shop interior
   in Phase 4.
2. **Khmer UI** translation (needs native review) and a mobile layout pass.
3. More facade variety by building type (texture atlases), rooftop details, weather.
4. Camera vs tree canopies: crowns can block the view from below (fade or pull in).
5. Zebra crossings from the 59 mapped crossing nodes; more landmark models (Wat Ounalom,
   Royal Palace when the region grows).
6. Profiling on more devices (only this Intel iGPU so far).

## Phase 3: delivered

* An authoritative world hub on a same-origin WebSocket. The cookie session and an Origin check
  gate it, and logins are re-validated every 30 s (log out or get suspended → disconnected).
* Rooms (shards) per region with capacity; interest management by 200 m cells (3×3); a 10 Hz
  tick sending only changes; per-connection send queues.
* Server-side movement validation against the real OSM footprints and water; authoritative
  fast travel; spawn spreading; resuming within 15 minutes.
* Remote avatars from each player's customisation, with snapshot interpolation, gait, name tags,
  speech bubbles and emotes (wave, **sampeah**, cheer, dance).
* Nearby (40 m) and world chat, persistent direct messages, a chat filter, rate limits.
* Friends with online presence, invites with "join your friend", mute, block (hides both ways),
  reports with chat evidence, and an admin moderation queue (warn, chat-mute, suspend).
* Production WebSocket transport: Vite proxy (dev/preview), `frontend/server.js` (Docker),
  an nginx example.

## Deferred from Phase 3 (still open)

1. **Scale-out** beyond one API process: rooms pinned to processes, Redis pub/sub for
   presence, direct messages and invites, and a shared rate-limit store (Phase 8). Today one
   process holds the whole world.
2. **Chat retention** policy and automatic deletion; moderator tools to hide individual messages.
3. A fuller chat filter (Khmer terms, obfuscation) with native-speaker input.
4. Server-side collision against tree trunks and poles (the client blocks them; the server
   checks footprints and water only).
5. Voice chat, player-to-player trading, parties: not planned yet.
6. A dedicated E2E API instance on the `ppw_test` database, so browser tests never put bots in
   the shared dev world (do this first in Phase 4).

## Phase 4: next (marketplace)

Virtual shop units with unique claims (database-level uniqueness, transactional claims, expiry,
disputes), merchant verification, a seller dashboard, a product catalogue, 3D storefronts
(the `/mall` food court as the interior template), in-world product interaction, a
server-priced multi-merchant cart and demo checkout (reusing the CampusEats order and payment
patterns, with integer minor units).
