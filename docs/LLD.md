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
verify ──▶ location ("your place") ──▶ complete ──▶ world (the wardrobe opens: make the avatar)
 (contact    (a private place anywhere in Phnom Penh, the public start area (the nearest one
  verified)   unless picked) and an explicit visibility choice)
```

`GET /auth/me` reports `onboarding.next_step`. `POST /me/onboarding/complete` returns 409 with
`details.next_step` if a step is missing. A new player (no roles chosen yet) gives an address
(everyone can buy) and gets `visitor` + `buyer` on completing; work roles (seller, driver) are
registered after that. There is no avatar step: until a player saves one,
`onboarding.avatar` is false, the world bootstrap and the world socket use the default look
(`schemas/me.py: default_avatar`, the same values as the client's `DEFAULT_AVATAR`), and the
city opens the wardrobe in its welcome mode (no Cancel; "Enter the city" saves). The start is a
public spawn area, never the home itself (other players would see where the player lives).
The web app's onboarding layout lets users revisit earlier steps but never skip ahead.

## Roles

`user_roles(user_id, role)` is unique. `visitor` is created active at registration. `buyer`
becomes active immediately (verified contact required). `seller` and `driver` start `pending`
and an admin approves or rejects them (`/admin/role-requests/{id}/approve|reject`, audited).
A rejected role can be requested again. Unticking a role sets it to `revoked`. `admin` cannot
be requested.

## System Office and work roles (`services/work_roles.py`, `SystemOffice.svelte`)

Work roles (seller, driver) are registered in the city, at the System Office: OSM building
1518 (`placements.ts SYSTEM_OFFICE_ID`, `multiplayer/buildings.py SYSTEM_OFFICE`, the same id in
every import), 30 m south of the Central Market spawn, with a generated `office` interior: a
service hall (the counter with the "Register a Work Role" service, waiting chairs, a ticket
machine, the notice board) and a records room; one floor. Places lists it with a route.

* E at the counter opens the office panel (`Buildings.onService`). `POST /me/work-role
  {role, note?, business?}` registers: a seller sends their business (the merchant application,
  `merchants.apply`: the seller role pending), a driver a note (the driver role pending). An
  administrator approves either, as before. `POST /me/work-role/leave` withdraws the role (a
  pending seller application leaves the admin queue as "withdrawn"; a seller holding a shop
  spot releases it first).
* The server accepts both only while the player is in the world at the office
  (`hub.at_building`: within 15 m of its footprint, from their live position), and keeps one
  work role at a time: `ONE_WORK_ROLE` (409) for a second one, also on `POST /me/roles` and
  `POST /merchant` (which stay for tools and tests).

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
| `lib/game/avatar/avatar.ts` | Classic avatar (the fallback only): loads `avatar.glb` once; per-avatar material clones; option visibility; per-joint batching; the colour palettes and their names |
| `lib/game/avatar/character.ts` | One avatar behind one interface (model, gait, emotes, vehicle rider, in-place `update`): the realistic avatar, or the classic one if the realistic models cannot load |
| `lib/game/avatar/realistic.ts` | Realistic avatars (`avatar-generator/`): loads `characters/realistic/{male,female}.glb` + `manifest.json`, clones with `SkeletonUtils`, recolours per player (skin tint, hair factor, repainted palette cells), adds a `RightWrist` socket for held products |
| `lib/game/avatar/RealisticAnimations.ts` | Gait clips (Idle/Walk/Run with hysteresis, stride phase kept, speed-matched playback), emote clips (Wave, Greet = sampeah, Cheer, Dance), IK carry pose; `RealisticEmotes` facade |
| `lib/game/avatar/ik.ts` | Rig-agnostic bone aiming and two-bone IK (any bone orientation) |
| `lib/game/vehicles/RealisticRider.ts` | Seats a realistic avatar: hips on the seat, IK feet to pegs/pedals and hands to grips; on the first frame it slides forward and leans until the grips are in reach |
| `lib/game/city/chunkGeometry.ts` | **Worker-safe** chunk → typed arrays: mitred road ribbons that follow the terrain, sidewalks, dashed centre lines, area polygons, buildings (walls with facade attributes, roofs, terrain-aware bases), tiered Khmer roofs, prop instance matrices, light pools, colliders, label/sign/model specs |
| `lib/game/city/chunk.worker.ts` | Web Worker: fetch → parse → `buildChunkData` → zero-copy `postMessage` |
| `lib/game/city/assemble.ts` | Main thread: typed arrays → meshes, instanced props, landmark GLBs, label sprites, per-chunk street-sign atlas, a "detail" group for LOD |
| `lib/game/city/materials.ts` | Shared materials; facade shader (6-bay atlas: four window styles and two shopfronts per building and bay, grime and streaks, glossy glass, night glow); light-pool and terrain materials |
| `lib/game/city/surfaces.ts` | World-space surface detail in one shader program (pavers and kerbs, asphalt grain and gutters, grass, unmapped ground patches, water ripples) switched by a per-material uniform and off in Performance mode; per-tree foliage tint |
| `lib/game/city/props.ts` | Meshopt-aware GLB loader; flattens Blender props to one geometry per material (keeping baked vertex colours); instancing; shared materials by name; foliage tint on leaf materials |
| `lib/game/city/lighting.ts`, `sun.ts` | Day/night: NOAA-style solar position for Phnom Penh, presets, sun/moon, sky, fog, exposure, night factor; sky environment map (PMREM, regenerated only when the sun moves noticeably; Quality only) |
| `lib/game/city/terrain.ts` | Mound terrain (mirror of `app/geography/terrain.py`) |
| `lib/game/city/collision.ts` | Grid of wall segments per chunk, plus small circular posts (trunks, poles); circle movement with sub-steps and sliding; escape-from-footprint; height-aware camera ray |
| `lib/game/city/ChunkManager.ts` | Worker pool (2), nearest-first streaming, one assembly per frame, unload with hysteresis, detail LOD, a change flag for the shadow cache, street and landmark lookup |
| `lib/game/city/CityEngine.ts` | Renderer, sky, lighting controller, cached grid-snapped shadows, terrain patch, the player (a stable holder group around a swappable `GameCharacter`), orbit camera with occlusion and terrain clamp, input, adaptive quality, minimap, perf counters (`window.__ppwPerf`) |
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

Camera-relative WASD at 2.6 m/s (a jog); Shift sprints at 6.5 m/s; Space jumps. The movement
model is in `city/locomotion.ts`:
- **Speed:** acceleration is capped at 6 m/s² and braking at 11 m/s².
- **Turning:** the heading eases towards the input faster when slow, within a 14 m/s² sideways-grip limit. Sharp turns cut the speed, so a reversal pivots instead of orbiting.
- **Jump:** 3.6 m/s take-off under 14 m/s² gravity, integrated exactly, so it gives the same 0.46 m hop at any frame rate. Height is local only: the protocol carries x/z, so other players see a jump as a short pause.

The realistic avatar picks Idle / Walk / Run / Sprint / Jump / Fall / Land clips from the ground
speed and jump state, at foot-sliding-free playback rates (`avatar/RealisticAnimations.ts`).
The player circle has a radius of 0.35 m
and moves in sub-steps of half the radius, so it cannot tunnel through walls. World bounds are
the playable bbox minus 3 m. The camera orbits at 2.5–22 m. A 2D ray against wall segments,
using each building's height, pulls the camera in front of buildings that would block the view.
Performance mode turns off shadows, lowers the pixel ratio to 0.75 and shrinks the streaming
radius to 300 m. It switches on automatically after about 3 s of frames slower than 24 fps.

### Enterable buildings (`lib/game/buildings/`)

Hand-built buildings that you can walk into, placed on open land (`placements.ts`). The first is
the riverside house, 25 m north-west of the Riverside spawn. It has a living room, dining room,
kitchen, bedroom, bathroom and hall. Each building is a GLB plus a JSON spec (format 2) from
`tools/blender/generate_house.py`; `spec.ts` types it.

- **Loading:** `Buildings` (created by the world page) fetches the spec, the GLB and two
  lightmaps when the player comes within 160 m, and frees them beyond 230 m.
- **Collision:** outer walls and partitions are rectangles, and doorways and the kitchen arch are
  real gaps. Lintels are walls with a base height: they block the camera, not walking. Furniture
  footprints block walking only. Each door leaf is its own collision owner and is rebuilt while it
  swings.
- **Interactions** (E, one prompt at a time): the candidate the player faces most directly wins,
  then the nearest relative to its reach.
  - Doors: "Open Door", "Open Bedroom Door"…
  - Light switches (per room group): "Turn Lights On/Off".
  - Appliances: "Turn On TV" (an animated canvas picture), "Turn On Stove" (flames).
  - Objects: "Inspect …", which shows a card with a title and text; E, Escape or walking away
    closes it.
  - Tables: "Sit at the Table" / "Sit at the Desk" sits on the nearest chair.
  - Seats: "Sit Down" / "Stand Up". The avatar walks to the seat's stand-up spot, then `sit()`
    turns it and lowers it onto the seat with the `Sit` pose.
  - The walk to a seat follows a path (`nav.ts`): A* on a 0.2 m grid around walls, open doors and
    furniture, string-pulled into a few straight legs. A dining chair behind the table's corner is
    still reached.
- **Shared state:** doors, windows, light groups and appliances are shared with the players
  around (see *Shared buildings* under the multiplayer protocol). A change shows at once where
  it is made; others' changes arrive through `Buildings.applyShared`. A door another player
  moves while this player stands in its swing waits until they step aside.
- **Floor:** `CityController.setGround` lifts the avatar onto the floor, porch and step, and step
  heights are eased. Other players stand on the floor too, on their own storey (the `l` of their
  moves): `Buildings.floorAt(x, z, storey)`.
- **Lighting:** the interior is unlit and multiplied by two lightmaps baked in Blender Cycles.
  The `day` map holds sun and sky through the windows. The `lamps` map holds one room group per
  channel: R front room, G kitchen, B bedroom, A bathroom. The shader computes
  `day × (1 − 0.96 × night) + lampColour × Σ channel × switch level`, so every room's lights
  switch and fade without runtime lights. Bulbs and lamp shades dim with their group. Lights
  start on after dark and off by day.
- **Indoor camera:** inside, with hysteresis at the doorway, `setInterior` keeps the camera within
  3.2 m of the avatar and under the ceiling, and lowers its pitch.
  - Two extra rays at the sides of the near plane stop walls beside the camera being seen through.
  - When cramped, the camera rises over the avatar's head.
  - The near plane drops to 0.1 m indoors.
  - The avatar is hidden when the camera is closer than 0.55 m to its head.
- **Indoor fill:** the sky fill becomes the room's light (warm when its lamps are on, daylight by
  day, dim in a dark room at night), so the avatar matches the room.
- **Cost:** the exterior, door and glass use PBR materials and take the city's sun, sky and
  shadows. Plain-coloured parts are vertex colours on one material per node.

#### Real OpenStreetMap buildings (`footprint.ts`, `osm.ts`, `procedural.ts`)

The same system opens real OSM buildings: every eligible building near the player gets an
interior generated to fit its footprint (auto mode, `AUTO_ENTERABLE` in `placements.ts`: the 8
nearest within 45 m, plus a few just passed). Three are listed by id with a fixed type and name
(`ENTERABLE`: a café, a mini-mart and a house on Sisowath Quay). Auto buildings become homes,
shops or cafés by their OSM kind (`interiorType`); a tag of just "building" gives mostly homes.
Shops and cafés get a made-up name on their sign (`interiorName`), or the building's own OSM
name if it has one.

- **Eligibility** (`planInterior`). A building is skipped, never given a broken door, when it has:
  - a raised part, or a landmark model or temple roof;
  - fewer than 14 m² or more than 2000 m², or a height under 2.8 m;
  - no room at least 3 m wide. A plain building's room is its outline inset by the wall (small
    notches are absorbed by shrinking it). For L-shapes, wings and courtyard buildings, the room
    is the biggest rectangle that fits inside, clear of the yard (`largestRoom`, a grid and the
    largest-rectangle-in-a-histogram sweep). A building in several parts uses its biggest part;
  - no entrance. The door needs a straight stretch of real wall, a road within 25 m in front,
    and no other building in front (shared walls of terraced shophouses). The straight way from
    the door to that road must not cross another building (no doors onto walled-in back yards).
- **The interior** is at most 12 × 12 m, against the entrance; deeper shophouses and big villas
  keep the rest closed.
- **Scan results** (`Buildings.scan`, 300 m around a spawn, E2E dataset): 428 of the 504
  buildings around Central Market (85%) and 146 of 208 around Wat Phnom (70%) can be entered.
  The rest mostly have no usable entrance (no straight street-facing wall with a clear way out),
  are under 3 m wide or 14 m², are huge halls, or are landmarks.
- **Planning cost:** each building is planned once (the result is cached by id) and nearest
  first, with a 4 ms budget per scan; the rest wait for the next scan a second later. Roads count
  by their extent, so a long straight street with distant vertices is not missed.
- **Rooms** (`planRooms`):
  - The room by the entrance (living room, sales floor, café), with more rooms behind it once
    the building is big enough. Partitions are 12 cm thick, with 1 m inner doors that swing into
    the room behind and open with E ("Open Kitchen Door").
  - Homes from about 32 m² get a living room at the front with a bedroom, kitchen and (if room)
    a bathroom behind. A wide house puts them side by side, each opening onto the living room;
    a narrow shophouse puts them one behind the other, each through the one before.
  - Shops get a storeroom from 8 m deep, cafés a kitchen from 9 m.
  - Every room is reachable from the entrance (tested for many sizes).
- **Upper floors:** a building tall enough for two storeys (about 7 m) gets stairs and an upper
  floor, if a straight flight fits in the entrance room. The flight has 14 steep steps, 2.8 m
  long, against the back wall or a side wall.
  - The flight is kept clear of doorways, of a café's counter and a shop's fridge, and of the
    way to every inner door. A 1 m landing at each end must be reachable from the room.
  - The upper floor stands on the same walls. Its front room is a family room with the
    stairwell (a railing round it) and front windows; the back rooms are bedrooms and a
    bathroom. Shops and cafés get their family home upstairs.
  - Only the first upper floor is built, even in taller buildings.
- **Windows:** on the ground floor's street front, wherever the real facade is straight
  (`Plan.front`, measured by the planner), a casement opens in each window: a home's own windows,
  or the middle of a shopfront.
  - The casement is a door of kind `window`, hinged from its sill and swinging in: E opens and
    closes it ("Open Window").
  - The wall has a real opening there, with a reveal through to the facade and a sill board.
    The facade gets a cut-out, but only on the building the player is at (4 window slots of the
    shader's 36; doors keep theirs), so the street shows them up close and painted windows from
    afar.
  - Space at an open window the player faces climbs through it, in or out (the engine's `climb`
    move): over the sill in a 1.1 s arc, without collision, to a spot kept clear of furniture
    inside or to the pavement. The prompt shows "Space to climb through". Standing where the
    casement swings, it cannot be closed, so "Climb Through Window" (E) is offered instead.
    Anywhere else, Space is a jump.
- **Storeys in play** (`Buildings`):
  - The player is on one storey of the building they are in, and only that storey's walls,
    furniture and doors are solid: the collision is swapped when they change storey. The swap
    happens half way up the stairs, where walls across the stairwell's ends keep anyone from
    walking under the stairs or falling down them.
  - The floor height is the storey's, or the slope of the stairs. The ceiling (indoor camera)
    is the storey's, or the upper one's over the stairs.
  - Prompts, room lights and the light on the avatar follow the storey. The upper storey is
    drawn only while the player is inside.
  - Lights have eight channels (two vec4 uniforms).
- **Furniture:** each kind of room has its own templates set against its walls and kept clear of
  doorways and door swings:
  - living room: sofa, TV, altar;
  - bedroom: bed, wardrobe, bedside lamp, a photo;
  - kitchen: counter with stove and sink, fridge, table for four, water jar;
  - bathroom: toilet, basin and mirror, a jar and a shower that turns on;
  - storeroom: racks, a stock book;
  - café kitchen: wok burners, a recipe board.
  Prompts are offered only for what is in the player's room, so nothing is reached through a
  wall.
- **Materials:** every face says what it is made of (`SURFACE`: paint, wood, fabric, metal,
  ceramic, concrete, cardboard, glass; or tiles of a given size), and the interior shader draws
  its detail from the surface's position, with no textures or UVs.
  - Wood gets grain, fabric a weave, metal brushing, tiles grout lines (laid on a fixed grid so
    the grout falls between the coloured tiles). Ceramic gets a glaze on top, concrete a speckle,
    cardboard fibres.
  - Painted plaster's mottling is baked into the vertex colours at build time, so it costs
    nothing to draw.
  - The fragment cost is a few sines and a fract (one noise for concrete), fading out below a
    couple of pixels. It is switched by `Buildings.interiorDetail`, which follows the city's
    quality (off in Performance mode).
  - Measured inside the café at 1920×1080 in GPU Chrome: 49.5 fps with interior detail on,
    50.2 off.
- **Lighting:** per vertex and computed at build time: daylight from the street front (back
  rooms get a little), lamp light from the same room, occlusion. Each vertex carries its room's
  light channel, so each room switches its own lamps (house rooms have a switch by their door,
  and windowless back rooms start lit). The shader scales it by day/night and the switches, so
  there are no textures and no runtime lights. That is two to four draw calls per interior, plus
  one per inner door leaf while the interior is visible.
- **Entering:** the doorway is cut into the OSM facade (`materials.setDoorSet`, shader discard)
  and into the building's collision ring (`collision.setDoors`). Both are per-owner sets shared
  with the walk-in shops. A glass or wooden door is hinged in the opening, and cafés and shops
  get a painted name board over it (a canvas texture). The floor sits 5 cm above the street,
  clear of the ground and plaza layers.
- **The camera** never ends up inside a building's mass: if it lands over a room (a player in
  the doorway, the camera behind them), it drops under that room's ceiling (`setCeiling`).
- **The server** lets players on foot stand inside any building footprint: every building may
  have an interior, and its walls are the client's collision. Water still blocks everyone, and
  vehicles still stay out of buildings (`MovementValidator.check`). Spawn and arrival spots
  still avoid footprints, except open walk-in shop floors.
- **Lifetime:** at most 16 generated interiors at once (one facade doorway slot each: the facade
  shader cuts 36, 16 for walk-in shops, 16 for buildings' front doors and 4 for the windows of the
  building the player is at). They are started 0.2 s apart, nearest first, and freed beyond
  100 m, never while the player is inside. Model buildings load within 160 m. Interiors are drawn
  only when they can be seen: from inside, through an open door within 35 m (OSM buildings), or
  within 60 m (the model house's windows).
- **Off the main thread:** the plan, furniture and vertex lighting (25–48 ms per interior in a
  Node benchmark on this machine) are made in `interior.worker.ts` (`buildInteriorData`) as
  plain typed arrays, handed back without copying. The main thread only wraps them into meshes
  and materials (`assembleInterior`, 0.3–0.6 ms) and adds the name sign (a canvas). A building
  that left the scan range meanwhile is dropped. Where workers are unavailable, or the worker
  fails, interiors are built on the main thread as before (`buildInterior`).

## Multiplayer protocol (`/api/v1/world/ws`)

JSON messages, field `t` = type (full list in `backend/app/multiplayer/protocol.py`).

| Client → server | Server → client |
|---|---|
| `move {x,z,yaw,s,l?}` (10 Hz while it changes; `l`: storey, absent on the ground floor) | `welcome {you, room, tick, x, z, yaw, online}` |
| `chat {ch: nearby\|world, text}` | `spawn {p: {id,u,n,av,x,z,yaw,v?,l?}}` (again when they save a new outfit), `despawn {id, why}` |
| `mount {v}`, `dismount` (Phase 5) | `ride {id, v: {id,k,c} \| null, x?, z?, yaw?}` (position only in your own), `vspawn {v: {id,k,c,x,z,yaw,mine?,name?}}`, `vdespawn {id}` |
| `emote {e: wave\|sampeah\|cheer\|dance}` | `state {ts, p: [[id,x,z,yaw,s,l?],…]}`, changed players only |
| `bset {b, k: door\|light\|app, id, on}`, `bget {b}` | `bstate {b, s: {"door:front": true, …}, mine?, all?}` |
| `travel {spawn}`, `invite {to}`, `join {from}` | `chat`, `emote`, `teleport`, `correct`, `invite`, `notify`, `online`, `error`, `kicked` |
| | `shops` (storefronts or a catalogue changed: reload `/market/shops`), `order {number, status}` (to the buyer and the merchant) |
| `ping {c}` | `pong {c, s}` |

Close codes: 4401 not signed in, 4403 bad Origin, 4409 onboarding incomplete, 4009 replaced by
a newer connection, 4003 suspended. The client reconnects with exponential backoff (1 → 15 s)
except after these final codes.

**Shared buildings** (`backend/app/multiplayer/buildings.py`, `frontend/src/lib/game/net/
BuildingSync.ts`): every client builds the same interiors, so a door is named by its building
(`osm:<buildings.id>` or a model building's id) and its own id. The room keeps what players
changed, in memory, until its last player leaves; then everything is back to the default every
client knows (doors shut, appliances off, switched lights on after dark). Rules on the server:
the player must be within 15 m of the building's footprint (the model house: of its centre and
radius, listed in `MODEL_BUILDINGS`); at most 8 changes and 40 requests a second; 64 parts per
building and 4000 buildings per room. No database tables.

- `bset` is kept and sent as `bstate` to every player in the 3 × 3 chunk cells around the sender,
  the sender too (`mine`), in one order. The sender showed it already; while one of its changes
  to a part is on its way, what the server sends about that part is older and is skipped, so
  nothing flicks back to a stale state, and its own change coming back settles it. Every client
  ends where the server did.
- `bget` (sent when a building loads, and for every loaded building after a reconnect) is
  answered with `all`: everything changed there; whatever is not listed goes back to its
  default, except the client's own changes still on their way.

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
price tags) and resolves the E-key interaction: at a shelf, into the basket
(`POST /cart/items` with the shop); at the counter, the counter panel; at the door, browse.
The basket is the cart lines from the shop's merchant: while the player stands in that shop the
avatar carries a red shopping basket with up to six of the picks in it, and after paying a kraft
paper bag in the shop's colours for a minute (both hang upright from the right hand, carry pose;
put away while riding). The cart by the door is decoration. The server allows positions on an
open shop's floor (`MovementValidator.set_open_zones`).

**Paying at the counter (`POST /shops/{id}/counter`, `checkout.counter_sale`).** Buying in
person needs nothing from the seller. One transaction takes the buyer's cart lines from this
shop's merchant, creates the payment intent and order (`fulfillment` pickup at this shop), takes
the demo payment, and completes the order at once (`paid → completed` is a system move used only
here; the history notes "Sold in person at the counter"; the seller's wallet is settled). Lines
from other shops stay in the cart. It is accepted only while the player stands on that shop's
floor in the world (`hub.in_shop`: the unit's footprint, 1 m margin for the doorway, from their
live position) and the shop is open. Errors: `403 AT_THE_COUNTER`, `409 SHOP_CLOSED`,
`BASKET_EMPTY`, `PRICE_CHANGED`, `ITEMS_UNAVAILABLE`, `INSUFFICIENT_FUNDS` (then nothing changes:
basket, stock and wallet stay as they were). The `Idempotency-Key` makes a retry return the same
receipt. Orders report `in_person`. The seller's world session gets
`{"t": "order", "sold": true, "total"}` ("Sold in person at your counter"). Orders placed ahead
for pickup are collected at the same counter (`POST /orders/{id}/received`).

**Shopkeepers (`game/shop/Shopkeepers.ts`).** A person stands behind each open shop's counter
(between the counter and the back wall, facing the door) and serves walk-in customers on the
seller's behalf. Who it is follows from the shop's id (`keeperFor`: body, a Khmer name, skin, hair,
clothes; FNV-1a hash), so every player sees the same shopkeeper; the realistic character is the
players' own pipeline (`createCharacter`), with an apron in the shop's colours fitted in front of
the clothes (measured on the skinned outfit in the idle pose; bib on Spine2, skirt on the hips,
neck straps). Name tag over the counter. Behaviour, all local to each player's client (nothing on
the network): a sampeah and "សួស្តី! Welcome to …" when the player walks in (again after 45 s),
turning to face them (at most 75° from the door, 4 rad/s), talking at the counter (the counter
panel's lines: the price, an order ready to collect, thanks with a sampeah after paying), speech
bubbles drawn over the shop's walls (they only come while the player is inside). Cost: one
character (~26–30k triangles, one mixer) per shopkeeper, so only at the nearest open shops within
30 m (kept to 40 m; a shopkeeper gives its place to a shop at least 3 m nearer: `planKeepers`),
at most 2, 1 on the low graphics setting; one out of the camera's view is neither drawn nor
animated (skinned meshes are not culled by three.js).

**My shop (the seller's panel, in the city: `components/myshop/`).** Sellers run their shop
without leaving the game: the toolbar's shop button or **B** (also ☰ → My shop, the System
Office's counter after registering, and `/world?panel=shop`, where the old `/seller` address now
redirects) opens a frosted panel over the city (a bottom sheet on a phone; opaque on the low
quality setting). Walking still works while it is open. Tabs:

* **Today** (`TodayTab`): a checklist until the shop is ready (approved, a spot, name and
  tagline, three products with photos, open), sales today / orders to do / last 30 days, and new
  (paid) orders with Accept.
* **Orders** (`OrdersBoard`): columns New, Preparing, Ready (Done with "All"); each order shows
  its next move from `allowed` as one button; cancel-and-refund sits behind "More", with a
  reason and a confirmation. It reloads on the world's `order` message (`ordersVersion`).
* **Products** (`ProductsGrid`): cards (photo, price tag, stock, status), filters (on the shelf,
  low stock, hidden or checked), one editor (name EN/KM, price, stock, category with its policy,
  the shelf model as tiles, description, photo upload, hide/show, remove with a confirmation).
* **Shop** (`ShopLook`): name EN/KM, tagline, theme, colour pairs or own colours, open; a live
  sign-and-awning preview. A seller with several spots picks the shop in the header.
* **Spot** (`SpotsTab`): the spots held (renew, hand over to another seller, give up, with a
  confirmation; route there), handovers to accept, decline or withdraw, and the 12 free spots
  nearest the player (`GET /market/units` within ±0.004° of their position, distance and compass
  direction from the city's projection). A spot is claimed in person: Go there draws the route;
  Claim appears within 25 m of it. This is a client rule: the claim API does not check position.
* **Business** (`BusinessForm`): the merchant details.

Customer messages are in People (**P**), as for every player.

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

## Realistic avatar contract (`avatar-generator/`, installed by `scripts/install_to_game.py`)

* `static/models/characters/realistic/{male,female}.glb` (Build A → male, Build B → female),
  meshopt-compressed, metres, facing +Z, feet at y = 0; 52-bone Mixamo skeleton
  (`mixamorig:*`, anatomical left at +X); clips `Idle Walk Run Wave Sit Talk Dance Greet Cheer`;
  morphs `Smile Excited Surprised Thinking Wink Blink MouthOpen`.
* `manifest.json`: per build the palette cell of every original material (16 px cells of the
  `<kind>.Outfit` texture), the baked skin tone, the default hair colour (hair texture is neutral
  grey with mean 0.5), measured foot-sliding-free walk/run speeds, height.
* Colour choices map to cells in `RECOLOR` (`realistic.ts`): top → jacket (male) or hoodie
  (female); bottom → pants; shoes → shoe upper; accent → panels, backpack and shoe accents.
  Hair style, garment styles and accessories are stored but not drawn: the realistic avatar is
  the game's only look. The classic avatar (`avatar.ts`) is drawn only if the realistic models
  cannot load (`createCharacter` falls back to it), so the game never ends up without avatars.
* `realistic.test.ts` fails if a GLB lacks a bone, clip, recolourable material or palette cell
  the game uses.

## Wardrobe (in the game: `Wardrobe.svelte`, `Drum.svelte`, `wardrobe.ts`)

* Opened with **O** or the shirt button. The camera turns to face the player
  (`CityController.setShowcase`: beside a glass panel on wide screens, above a glass sheet on
  phones), movement keys are ignored, the HUD and other players' name tags hide.
* What the realistic avatar shows, as wheels (`wardrobe.ts`): top (style: the original hoodie,
  under a jacket on build A; a t-shirt; a short-sleeved button shirt; and a colour), bottoms
  (joggers, jeans, shorts; colour), shoes (sneakers, sandals; colour), hat (none, cap, bucket
  hat; the backpack's colour), backpack (on or off; its colour also trims the jacket's panels,
  the shoes and the hat), hair colour, and body (build, skin tone). Turned with the mouse wheel or
  touchpad (one choice per notch), the arrow keys, a drag, or a click; `[` and `]` change
  category. "Surprise me" is a random outfit (`randomOutfit`).
* Garments and old avatars: an avatar's `model` is "avatar" for avatars saved before garments
  existed (and new players until they save): the realistic character wears the original outfit
  (hoodie, joggers, sneakers, backpack) whatever its old style fields say (`realistic.outfitOf`),
  so nobody's look changed. The wardrobe opens such an avatar `dressed()` in that outfit and
  saves `model: "outfit"`, after which `top_style` (hoodie | tee | shirt), `bottom_style`
  (trousers | jeans | shorts), `shoe_style` (sneakers | sandals) and the accessories `cap`/`hat`
  (a bucket hat, one hat at a time) and `backpack` are worn.
* The realistic GLB holds every garment as its own mesh; the manifest's `wardrobe` says which
  mesh is which choice (`slot`, `variant`, `with`: backpack straps, prints and the flag patch are
  fitted per top) or which `region` of skin it is (arms, legs, ankles, feet: kept only where some
  choice shows them) and the hair on top of the head (and head-worn sunglasses) that hides under a
  hat; `hidden_when` lists the garments that hide each region. `realistic.meshShown` applies it:
  a change of garment is a visibility change in place, never a rebuild. About 20–30k triangles
  and 14–16 draw calls per character, whatever is worn.
* Every turn is worn at once (`CityController.setAvatar`: colours in place, another build is a
  rebuild, `GameCharacter.update` says which; a product held in a shop moves to the new hands).
  Save → `PUT /me/avatar`, then the hub sends the player's card again (`spawn`) to everyone who
  sees them, so they see the new outfit without reconnecting. Cancel or Escape puts back what
  was worn.
* Slow graphics (`low` quality): the panel is opaque instead of frosted glass (no backdrop blur).

## Avatar asset contract (`tools/blender/generate_avatars.py`)

* Joints: `BodyRoot`, `Left/Right` × `Leg/Knee/Ankle`, `Arm/Elbow/Wrist` (the CampusEats rig).
* Materials: `Skin`, `Hair`, `Top`, `Bottom`, `Shoes`, `Accent`, `AccentDark` (recoloured) and
  fixed `Eyes`, `EyeHighlight`, `Lips`, `Sole`, `Laces`, `Frame`.
* Optional parts: `opt__<group>-<value>__<part>`, with groups `body`, `top`, `bottom`, `hair`, `acc`.
  `avatar.test.ts` fails if the GLB lacks any option the API accepts.
