# Roadmap

| Phase | Theme | Status |
|---|---|---|
| 1 | Foundation: accounts, verification, roles, avatars, real map, one playable neighbourhood | ✅ Done |
| 2 | 3D city quality | ✅ Done |
| 3 | Multiplayer | ✅ Done |
| 4 | Marketplace (shop claims, storefronts, cart, demo checkout) | ✅ Done |
| 5 | Transportation (bicycle, motorbike, routing, parking; car and tuk-tuk later) | **✅ Done (this build)** |
| 6 | Delivery (simulated jobs, tracking) | Next |
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
6. ~~A dedicated E2E API instance~~: done in Phase 4 (API :8001 on `ppw_e2e`).

## Phase 4: delivered

* **1,680 virtual shop units** generated from real Daun Penh building frontages on public
  streets (never residential buildings), with permanent codes and a claim map.
* Merchant applications (business details, hours, private address, verification documents)
  with administrator approval; the seller role is granted in the same step.
* Exclusive claims guaranteed by the database; evidence and review for units at real
  businesses; disputes; 30-day terms with renewal and expiry; release; transfers; revocation.
* Seller dashboard: units map, storefront customisation (name EN/KM, tagline, theme, colours,
  open/closed), products (category policy, photos without metadata, display models, stock),
  orders with explicit transitions, demo revenue, customer messages.
* Walk-in 3D storefronts at the real frontage: doorway, sign, awning, shelves with product
  facings and price tags, island table, cart and counter. E picks a product up (held in the
  avatar's hand), E puts it in the cart, E at the counter opens checkout. "Walk there" from the
  shop directory.
* Server cart, idempotent multi-merchant demo checkout, a payment that cannot complete twice,
  expiry that releases stock, refunds (simulated), buyer order tracking.
* The isolated E2E stack.

## Deferred from Phase 4 (still open)

1. **Delivery fulfilment** (orders are pickup-only; the delivery states exist for Phase 6) and
   the **demo wallet balance and ledger** (Phase 7 debits the payment intent).
2. **Other players do not see what you carry**, and shop interiors have no per-shop lighting.
3. A KHR price option (USD cents only for now) and per-branch stock (stock is per product).
4. **Khmer UI** for the dashboard (shop names and products already accept Khmer); the Khmer
   category names need native review.
5. Real business verification beyond document upload (e.g. a check against the Ministry of
   Commerce register) and a dispute conversation thread.
6. A content-moderation pass on product photos and names (today: admin review for restricted
   categories only).
7. Uploaded GLB models for products (sellers choose from built-in display models).

## Phase 5: delivered

* **Road graph from OSM.** The importer splits the real OSM ways at shared nodes into a routing
  graph (`road_nodes`, `road_edges`: 1,109 nodes, 1,485 edges, 74 km in Daun Penh), clipped to
  the playable area. Every edge carries per-direction access masks for foot, bicycle and
  motorbike, derived from the highway class and the OSM `access`, `vehicle`, `motor_vehicle`,
  `motorcycle`, `bicycle`, `foot`, `oneway`, `oneway:bicycle` and `junction` tags (317 one-way
  edges; 100 private service roads excluded), plus OSM `maxspeed` where tagged. Traffic signals
  sit on graph nodes.
* **Routing.** `GET /routes` (A*, travel time, a short wait at signals for vehicles): one-way
  streets bind vehicles, not pedestrians; turn-by-turn steps with English and Khmer street names;
  road position ↔ world position (`/roads/snap`, `/roads/position`).
* **Vehicles.** Blender models of a step-through city bicycle (front basket) and a generic
  underbone motorbike, with steering, wheel spin, lean, headlights at night and a rider posed with
  leg and arm IK (pedalling on the bicycle). A garage (V) hands out one free starter vehicle of
  each kind, parked on the nearest street; repaint, valet ("bring it here", once a minute), give
  back.
* **Riding.** F gets on when you stand next to your vehicle. W/S throttle and brake, A/D steer
  (kinematic bicycle model, less lock at speed); a chase camera; speedometer, OSM speed limit,
  one-way and wrong-way indicators. The server validates every move against the vehicle's top
  speed (bicycle 25 km/h, motorbike 45 km/h, ×1.35 tolerance) and keeps vehicles on roads their
  mode may use (carriageway + pavement, car parks); shop floors are foot-only.
* **Lane-aware guidance.** Routes are drawn in the world (chevron ribbon, destination beacon) and on
  the minimap. Vehicles keep to the right-hand lane (Cambodia drives on the right), the right-hand
  lane of one-way streets; walkers keep to the pavement. The autopilot rides or walks the route
  (pure-pursuit steering, slowing for bends and speed limits) and re-plans when you leave it.
* **Parking.** F again parks: at the kerb or on the pavement of a through road, anywhere in
  alleys and OSM car parks, never mid-carriageway or on top of another vehicle (the server pulls
  over up to 6 m). Disconnecting or fast-travelling while riding parks the vehicle nearby.
* **Sync.** Other players see riders on their vehicle (kind and colour), and parked vehicles in
  their area as world objects without the owner's identity; hidden players' and blocked players'
  vehicles are never shown.

## Deferred from Phase 5 (still open)

1. **Cars and tuk-tuks** (remorque): the mode bits (`car = 8`) and access rules exist; models,
   handling for four wheels and a wider collision shape do not.
2. **Traffic rules beyond one-way**: no enforced speed limits, signals or turn restrictions
   (OSM `turn:lanes` and `restriction` relations are not imported); riding the wrong way is
   flagged, not prevented.
3. **No NPC traffic** (principle 2: no fake crowds) and no player–vehicle collisions on the server.
4. **Bridges and layers** are routed but not rendered as decks; the graph ignores `layer`.
5. Buying, selling or renting vehicles comes with the Phase 7 wallet (today: free starters).
6. A Khmer voice/UI for directions (step text is English; street names are bilingual).

## Phase 6: next (delivery)

Simulated delivery jobs on the routing graph: driver profiles (the driver role), job offers
from paid orders with "delivery" fulfilment, pickup at the shop's door, a route to the buyer's
virtual drop-off point, tracking on the buyer's order page, and delivery states on the order
machine that already exist.
