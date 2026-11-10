# Low-level design (Phases 1–5)

## Backend modules (`backend/app`)

| Module | Responsibility |
|---|---|
| `core/config.py` | Settings from env / repo `.env`; production safety checks |
| `core/security.py` | Argon2 hashing, session tokens (`sub` + `sid`), CSRF tokens, HMAC verification codes |
| `core/database.py` | Async SQLAlchemy engine; `Base` with naming convention; UUID/timestamp mixins |
| `core/rate_limit.py`, `core/errors.py` | Sliding-window limiter; `{"error": {code, message, details}}` envelope |
| `api/deps.py` | Session resolution (token → `sessions` row → user), `require_role`, client IP |
| `services/accounts.py` | Register, authenticate, open/revoke sessions, start/confirm verification |
| `services/onboarding.py` | Onboarding state machine, role selection, private addresses, spawn choice |
| `services/geo.py` | Search (pg_trgm + LIKE over places, streets, landmarks), reverse lookup, nearby buildings, spawn points, regions |
| `services/world.py` | World config (projection + chunk index), bootstrap, chunk ETags |
| `geography/projection.py` | `WorldProjection` (pyproj, vectorised shapely transforms), chunk maths, geodesic distance |
| `geography/osm.py` | Pure parser: Overpass JSON → typed features (estimates labelled) |
| `multiplayer/hub.py` | Rooms, presence, 200 m interest grid, 10 Hz tick (spawn/despawn/state diffs), chat and emotes, travel and invites, per-connection writer queues, persistence and session re-validation |
| `multiplayer/protocol.py`, `validation.py`, `chatfilter.py` | Message schemas and limits; server-side movement validation (speed, bounds, footprints, water); chat normalisation and masking |
| `services/social.py` | Friends, blocks, mutes, direct messages, reports (with chat context); pushes relationship changes to the hub |
| `api/v1/realtime.py` | `/api/v1/world/ws`: Origin check, cookie session, onboarding gate, receive loop |
| `geography/importer.py` | Upserts, pruning, landmark→building links, chunk payloads (roads carry `af`/`ab` mode masks and `vmax`), the road graph (`sync_road_graph`), open-ground spawn placement |
| `marketplace/units.py` | Shop-unit generation from the chunk payloads (storefront kinds only, a real street in front, fits inside the footprint, clear of other buildings); stable `unit_key`, permanent codes |
| `marketplace/merchants.py` | Merchant applications (+ seller role), documents, approve/reject/suspend |
| `marketplace/claims.py` | Claim (merchant row lock, live-claim unique index as the final arbiter), evidence and review, release, renew, expire, transfer, dispute, revoke; opens and ends shops |
| `marketplace/catalog.py` | Storefronts for the world (catalogue version per merchant), products, stock, photos, category policy, restricted-product review |
| `marketplace/checkout.py` | Cart repricing, idempotent checkout, demo payment confirmation (row lock, idempotent), expiry, order state machine with actor rules, simulated refunds, revenue |
| `marketplace/media.py`, `sweeper.py` | Image re-encoding (WebP, no metadata), private documents (magic-byte check); background expiry of claims and unpaid checkouts (every 60 s, also lazily on read) |
| `transport/specs.py` | Travel modes (bits, top and cruise speeds, sizes), mount range, riding margins, kerb band; the JSON fixture shared with the client |
| `transport/network.py` | Pure: OSM tags → per-direction access masks; `build_graph` (split ways at shared nodes, clip to the area, synthetic dead ends) |
| `transport/routing.py` | In-memory `RoadGraph` per region: snap (world → road position), `point_at`, A* (travel time, signal waits, one-way per mode), turn-by-turn steps |
| `transport/area.py` | `TravelArea`: where a mode may ride (corridors around usable edges + car parks) and park (not in a through road's core) |
| `transport/parking.py` | `ParkedIndex`: parked vehicles per region in 200 m cells (shared by the region's rooms) |
| `transport/vehicles.py` | Garage: starter vehicles, placement at the nearest legal spot, valet, repaint, give back |

## Onboarding state machine

```text
verify ──▶ avatar ──▶ role ──▶ location ──▶ complete ──▶ world
 (contact      (avatar     (roles_chosen_at   (spawn + explicit visibility
  verified)     saved)      set; visitor-only  + address if buyer)
                            is valid)
```

`GET /auth/me` reports `onboarding.next_step`. `POST /me/onboarding/complete` returns 409 with
`details.next_step` if a step is missing. The web app's onboarding layout lets users revisit
earlier steps but never skip ahead.

## Roles

`user_roles(user_id, role)` is unique. `visitor` is created active at registration. `buyer`
becomes active immediately (verified contact required). `seller` and `driver` start `pending`
and an admin approves or rejects them (`/admin/role-requests/{id}/approve|reject`, audited).
A rejected role can be requested again. Unticking a role sets it to `revoked`. `admin` cannot
be requested.

## World chunk payload (`GET /world/chunks/{ix}_{iz}`)

```jsonc
{
  "key": "0_-1", "ix": 0, "iz": -1, "size": 200,
  "roads":     [{ "id", "name", "name_en", "name_km", "cls": "primary", "w": 14.0,
                  "oneway", "bridge", "layer", "pts": [[x, z], …] }],      // clipped to the chunk
  "buildings": [{ "id", "name", "name_km", "kind", "h": 16.1, "min_h": 0,
                  "hs": "osm|levels|estimated", "colour",
                  "polys": [[outer, hole, …], …] }],                       // owned by the chunk containing its representative point
  "areas":     [{ "kind": "park|water|…", "name", "polys": [...] }],       // clipped to the chunk
  "landmarks": [{ "name", "name_en", "name_km", "cat", "sub", "imp": 1-3, "p": [x, z] }],
  "features":  [{ "k": "tree|street_lamp|traffic_signals|crossing", "p": [x, z] }]
}
```

Coordinates are world metres (2 decimals): `x = east`, `z = −north`. Rings are not closed
(the last point is not repeated).

## Frontend (`frontend/src`)

| Path | Responsibility |
|---|---|
| `hooks.server.ts` | `/api` proxy (hop-by-hop headers stripped, `X-Forwarded-*` overwritten) and security headers |
| `lib/api/*` | Typed client (CSRF echo, error envelope → `ApiError` with `fieldErrors`), endpoint functions, types |
| `lib/stores/session.svelte.ts` | Session store: request-scoped `page.data.user` during SSR (no cross-request leaks), client override after mutations; routing helpers |
| `lib/geo/projection.ts` | proj4 mirror of the backend projection; chunk keys; compass/yaw helpers |
| `lib/game/avatar/avatar.ts` | Loads `avatar.glb` once; per-avatar material clones; option visibility; per-joint batching |
| `lib/game/city/chunkGeometry.ts` | **Worker-safe** chunk → typed arrays: mitred road ribbons that follow the terrain, sidewalks, dashed centre lines, area polygons, buildings (walls with facade attributes, roofs, terrain-aware bases), tiered Khmer roofs, prop instance matrices, light pools, colliders, label/sign/model specs |
| `lib/game/city/chunk.worker.ts` | Web Worker: fetch → parse → `buildChunkData` → zero-copy `postMessage` |
| `lib/game/city/assemble.ts` | Main thread: typed arrays → meshes, instanced props, landmark GLBs, label sprites, per-chunk street-sign atlas, a "detail" group for LOD |
| `lib/game/city/materials.ts` | Shared materials; facade shader (window/shopfront atlas, night glow); light-pool and terrain materials |
| `lib/game/city/props.ts` | Meshopt-aware GLB loader; flattens Blender props to one geometry per material; instancing; shared materials by name |
| `lib/game/city/lighting.ts`, `sun.ts` | Day/night: NOAA-style solar position for Phnom Penh, presets, sun/moon, sky, fog, exposure, night factor |
| `lib/game/city/terrain.ts` | Mound terrain (mirror of `app/geography/terrain.py`) |
| `lib/game/city/collision.ts` | Grid of wall segments per chunk, plus small circular posts (trunks, poles); circle movement with sub-steps and sliding; escape-from-footprint; height-aware camera ray |
| `lib/game/city/ChunkManager.ts` | Worker pool (2), nearest-first streaming, one assembly per frame, unload with hysteresis, detail LOD, a change flag for the shadow cache, street and landmark lookup |
| `lib/game/city/CityEngine.ts` | Renderer, sky, lighting controller, cached grid-snapped shadows, terrain patch, avatar and `PlayerAnimations`, orbit camera with occlusion and terrain clamp, input, adaptive quality, minimap, perf counters (`window.__ppwPerf`) |
| `lib/game/player/PlayerAnimations.js` etc. | Reused unchanged from CampusEats World |

### Rendering pipeline (Phase 2)

```text
 ChunkManager ──postMessage(key)──▶ chunk.worker: fetch /world/chunks/{key} → buildChunkData()
       ▲                                 (ExtrudeGeometry, ribbons, roofs, matrices; no DOM)
       └──── typed arrays (transferred, zero-copy) ◀──┘
 assemble (≤ 1 chunk per frame): BufferGeometry + shared materials, InstancedMesh per prop part,
 landmark GLB clones, label sprites, sign atlas  →  scene  +  colliders  +  changed flag
```

* **Facade shader** (`materials.ts`): wall UVs are (metres along the wall, metres above the
  base). The fragment shader tiles 4 m × 3.3 m bays from a 2-cell atlas. The ground storey of
  shophouse-type buildings (`facade.x = 1`, ≤ 30 m tall, no Khmer roof) uses the shopfront
  cell. At night, `uNight` lights about 42 % of windows (hashed per building, bay and storey)
  plus every shopfront. It samples with `textureGrad` on continuous coordinates, so there are
  no mip seams.
* **Shadows** are cached (see `docs/perf/README.md`). **Detail LOD** hides props, pools and
  signs beyond about 240 m.
* **Terrain**: a 72×72 displaced patch per mound. Ribbons are densified to 2.5 m on the hill;
  buildings stand on the lowest ground under their footprint. Props, labels, signs, the player
  and the camera follow `terrain.height(x, z)`. Collider heights are absolute.
* **Day/night**: live mode re-evaluates the sun every 2 s. Below −3° the moon takes over. The
  night factor smoothsteps from +4° to −8° and drives windows, lamp emission and light pools.

### Movement and camera

Camera-relative WASD; walk at 2.6 m/s, run at 6.5 m/s. The player circle has a radius of 0.35 m
and moves in sub-steps of half the radius, so it cannot tunnel through walls. World bounds are
the playable bbox minus 3 m. The camera orbits at 2.5–22 m. A 2D ray against wall segments,
using each building's height, pulls the camera in front of buildings that would block the view.
Performance mode turns off shadows, lowers the pixel ratio to 0.75 and shrinks the streaming
radius to 300 m. It switches on automatically after about 3 s of frames slower than 24 fps.

## Multiplayer protocol (`/api/v1/world/ws`)

JSON messages, field `t` = type (full list in `backend/app/multiplayer/protocol.py`).

| Client → server | Server → client |
|---|---|
| `move {x,z,yaw,s}` (10 Hz while it changes) | `welcome {you, room, tick, x, z, yaw, online}` |
| `chat {ch: nearby\|world, text}` | `spawn {p: {id,u,n,av,x,z,yaw,v?}}`, `despawn {id, why}` |
| `mount {v}`, `dismount` (Phase 5) | `ride {id, v: {id,k,c} \| null, x?, z?, yaw?}` (position only in your own), `vspawn {v: {id,k,c,x,z,yaw,mine?,name?}}`, `vdespawn {id}` |
| `emote {e: wave\|sampeah\|cheer\|dance}` | `state {ts, p: [[id,x,z,yaw,s],…]}`, changed players only |
| `travel {spawn}`, `invite {to}`, `join {from}` | `chat`, `emote`, `teleport`, `correct`, `invite`, `notify`, `online`, `error`, `kicked` |
| | `shops` (storefronts or a catalogue changed: reload `/market/shops`), `order {number, status}` (to the buyer and the merchant) |
| `ping {c}` | `pong {c, s}` |

Close codes: 4401 not signed in, 4403 bad Origin, 4409 onboarding incomplete, 4009 replaced by
a newer connection, 4003 suspended. The client reconnects with exponential backoff (1 → 15 s)
except after these final codes.

**Client side** (`frontend/src/lib/game/net/`): `WorldSocket` (reconnect, ping),
`Interpolator` (renders remote players 120 ms in the past; shortest-arc turns; ≤ 200 ms
extrapolation; snaps on teleports), `RemotePlayers` (avatars from each player's
customisation, gait, emotes, name tags, speech bubbles), `WorldSession` (reactive state for
the UI; sends movement only when it changes), `avatar/emotes.ts` (pose layers over the gait).

## Marketplace (Phase 4)

**Claims.** `claim_unit` locks the merchant row (per-merchant limit of 3 live units), checks
the unit, then inserts the claim. The partial unique index
`uq_property_claims_live (property_id) WHERE status IN ('pending','approved')` decides any race:
the loser's insert fails and is answered `409 UNIT_TAKEN` (tested by forcing the race past the
application check). Units at a named real business need a document and a note; the claim waits
`pending` for an administrator (14-day review window). Approved claims run 30 days and are
renewable; `sweeper.py` expires them. Ending a claim ends its shop and cancels pending transfers.

**Order state machine.**

```text
draft → pending_payment → paid → merchant_accepted → preparing → ready_for_pickup → completed
                     ↘ cancelled   ↘ refunded (from paid … ready_for_pickup; stock returned, Refund row)
ready_for_pickup → assigned_to_driver → picked_up → in_transit → delivered → completed   (Phase 6)
```

Actors: the system pays and expires; the merchant accepts, prepares, readies, completes or
refunds; the buyer cancels (unpaid: the whole checkout; paid: refund) and confirms collection.
Every move is an `order_events` row. `allowed` in each order response lists the caller's moves.

**Checkout.** `POST /checkout` needs an `Idempotency-Key`. It locks the buyer's cart, then the
inventory rows in product-id order (no deadlocks), re-reads prices, compares with
`expected_total_minor`, creates one `payment_intent` and one order per merchant, decrements
stock and empties the cart, in one transaction. A replay with the same key and body returns the
same intent; a different body is `409 IDEMPOTENCY_KEY_REUSED`. `confirm` locks the intent; a
second call returns the first result (`already_confirmed`).

**Walk-in shops (client).** `game/shop/layout.ts` turns a unit into a local frame (a along the
frontage, n inward). The doorway is a 5 m gap: the collision world ignores wall contacts on it
(`CollisionWorld.doors`), and the facade shader discards wall fragments inside it (uniforms for
the 16 nearest doors), so no chunk geometry is rebuilt. `Storefronts.ts` builds the interior
(inward-facing walls, floor, ceiling, Blender shelves and table, CampusEats counter and cart),
the sign (canvas, EN + KM) and the awning, loads products within 45 m (several facings each,
price tags) and resolves the E-key interaction: pick up (held at the right wrist, carry pose),
put in the cart (`POST /cart/items`), put back, pay at the counter, browse at the door.
The server allows positions on an open shop's floor (`MovementValidator.set_open_zones`).

## Transport (Phase 5)

**Road graph.** `build_graph` walks each routable way's node ids; a node used by two ways (or
twice by one) and every way end splits the way, so an edge never contains a junction. Edges are
clipped to the movement bounds; a clipped end gets a synthetic negative key. Access masks per
direction: the class default (vehicles on motor roads; foot and bicycle on footways, paths,
pedestrian streets; foot only on steps), then `access` / `vehicle` / `motor_vehicle` (may only
re-open what the class allows) and the specific `motorcycle` / `bicycle` / `foot` tags; then
one-way (`oneway=yes|-1`, roundabouts) removes the vehicle bits from the backward direction
(`oneway:bicycle=no` keeps bicycles).

**Routing.** Cost = length / speed (foot 2.6 m/s, bicycle 5.5, motorbike min(10, OSM limit or
class default)) + 6 s at signals for vehicles. A* with the straight-line time to the goal. Each
end is snapped to the 4 nearest usable edges and the best combination wins (including the
walk to the road), so a dead-end fragment never blocks a route. Steps measure turns over a 15 m
baseline either side of the junction and fold legs shorter than 12 m into one manoeuvre.

**Riding (server).** `MovementValidator.check` takes the mode's limit (top speed × 1.35 + 2 m);
vehicles are refused inside footprints even on open shop floors, and `TravelArea.allows`
(corridor = half width + 2.75 m) keeps them on usable roads (`correct {why: "offroad"}`).
Mount: own vehicle, within 3 m, on foot; the vehicle leaves the parked index synchronously
(two mounts cannot both win). Dismount: `nearest_parkable` within 6 m (rings of candidates;
outside the core `half − 2.2 m` of through roads, outside footprints, ≥ 1.0/1.3 m from other
vehicles) or `PARKING_NOT_ALLOWED`. Leaving, fast travel and joining a friend park the vehicle
(within 30 m). Riders' positions are persisted with the 30 s save.

**Riding (client).** `kinematics.ts` (throttle, brake, reverse for motorbikes, steering lock
falling with speed, yaw rate = v/L·tan δ, lean = atan(v·ω/g)) in 50 ms sub-steps; collisions
with `moveCircle`; `RoadNetwork` (from chunk roads, margin 2.0 m) stops the vehicle at the edge of
the riding area (sliding along it). `Rider.ts` seats the avatar: hips onto the `Seat` anchor,
two-bone leg IK to the pegs or the turning pedals, arm IK to the grips; the rider leans with
the vehicle. Remote riders derive wheel spin, steering and lean from the interpolated motion.

**Guidance.** `lanePath` offsets each route segment into its lane (two-way: w/4 right of the
centreline; one-way: w/2 − 1.7 m; alleys: centre; walking: w/2 + 0.8 m on the pavement) and
joins them; `RouteLine` draws it, `RouteGuide` projects the player onto the route (forward-only
window) for the next step and remaining distance; `PathFollower` + pure pursuit drive the
autopilot (look-ahead 4–14 m, slower in bends, under OSM limits, stopping at the end).

## Avatar asset contract (`tools/blender/generate_avatars.py`)

* Joints: `BodyRoot`, `Left/Right` × `Leg/Knee/Ankle`, `Arm/Elbow/Wrist` (the CampusEats rig).
* Materials: `Skin`, `Hair`, `Top`, `Bottom`, `Shoes`, `Accent`, `AccentDark` (recoloured) and
  fixed `Eyes`, `EyeHighlight`, `Lips`, `Sole`, `Laces`, `Frame`.
* Optional parts: `opt__<group>-<value>__<part>`, with groups `body`, `top`, `bottom`, `hair`, `acc`.
  `avatar.test.ts` fails if the GLB lacks any option the API accepts.
