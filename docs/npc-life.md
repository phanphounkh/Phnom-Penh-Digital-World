# NPC identities and daily activity

This increment changes local ambient characters, shopkeepers and the practice-delivery
host. Player models, customizations, account data and the multiplayer protocol are preserved.

## Appearance

Four NPC-only MakeHuman GLBs supply broad/round and slender/oval faces for both existing
body builds. Jaw, nose, cheek and lip geometry changes; this is not just a colour swap.
Existing deterministic clothing, skin/hair palettes and names remain. The player uses the
original `realistic/` assets and NPCs use `npcs/`. Head variants reuse the 52-joint rig,
wardrobe and all thirteen existing animation clips. Facial feature variation does not
represent an individual's ethnicity, age or real identity.

Each compressed model is approximately 2 MB, lazy-loaded and cached per variant. No new
runtime dependencies or remote asset services. Licenses are recorded alongside the assets
in `frontend/static/models/characters/npcs/LICENSE.md`.

## Activity and limits

- Pedestrians use existing safe pavement routes derived from loaded OSM streets. They walk
  at varied 0.78–1.22 m/s, pause, turn, greet the player with G and respond to a nearby player
  jump with a small hop and landing. Jump responses have an eight-second cooldown.
- An open virtual shop within 4.5 m, or a nearby eligible decorative storefront, can trigger
  a short browsing stop. Afterwards an NPC carries a paper shopping bag attached to its hand.
  **This is window browsing and fictional shopping activity**, not checkout, inventory,
  payment or entry into a shop. No marketplace orders or money change.
- Medium/High allow one ambient rider in addition to the existing two/three walkers. Low
  keeps one walker and no ambient traffic. Riders reuse the player's existing motorbike or
  bicycle asset, hand/foot IK, wheel animation and cycling motion.
- The rider chooses nearby mapped road segments with recorded access/direction, stays on
  existing right-hand lane offsets, and brakes for the local player and collision obstacles.
  Route sampling rejects water, building interiors, elevated roads and invalid corridors.
  At an endpoint it joins a nearby validated continuation, or waits. It does not make an
  unsafe U-turn to keep moving. Traffic lights and full intersection right-of-way are not
  simulated. This is a small ambient population, not city-scale traffic AI.
- Pedestrians unload beyond 65 m; riders beyond 110 m. Shared props and owned colliders are
  removed on unload, quality changes and teardown. Outdated asynchronous loads are disposed.
- NPC activity remains **local to each browser**, not synchronized shared people. Multiplayer
  player movement remains under the existing server-authoritative system.

## Reproduce face assets

The existing avatar-generator build resources and Blender profile must already be installed.
For each `male|female` and `broad|slender` combination:

```sh
BLENDER_USER_RESOURCES="$PWD/avatar-generator/assets/blender-user" OMP_NUM_THREADS=2 blender --background --threads 2 --python-use-system-env --python avatar-generator/scripts/generate_npc.py -- male broad
frontend/node_modules/.bin/gltf-transform meshopt /tmp/ppg-npc-faces/male-broad/male_avatar_game.glb frontend/static/models/characters/npcs/male-broad.glb
```

Intermediates are kept under `/tmp/ppg-npc-faces`, never copied over the player's original
GLBs or manifest. `frontend/tests/npc-assets.test.js` checks geometry diversity, download
budget, skeleton/clip compatibility and the original player asset checksums.

## Verification

Unit/asset tests cover stable identities, movement/collider cleanup, stale asset loads,
jump/landing, browsing bags, rider mounting, movement/braking, quality limits, road access
and lane direction. TypeScript/Svelte checks and the production Docker build also run.

`frontend/tests/perf/npc-life.mjs` checks actual models, player-triggered jumping, driving,
cycling and Low limits in Chrome. It disconnects the QA client's movement sync before
repositioning its camera/player and explicitly selects both vehicle kinds to keep the test
repeatable. The simulation and animations continue normally. This setup does not establish
NPC synchronization across players. Actual screenshots go under `/tmp/ppg-npc-*.png` and
measurements to `docs/perf/npc-life.json`. The existing online street-life test separately
checks connected player movement/greeting/postcards.

`frontend/tests/perf/npc-shopping.mjs` observes browsing at a nearby eligible mapped
building façade. The existing demo market itself had no safe pedestrian route in this
test, so no NPC was forced to appear there. The successful fixture is around Street 130
(derived sidewalk position x=224.30, z=-68.26). The rendered café name is fictional.

Measured Chrome/Intel integrated-graphics stationary comparison at Street 144, Medium,
noon, 1280×720, identical player position/camera, five-second RAF sample:

| Metric | Previous street-life increment | NPC increment |
| --- | ---: | ---: |
| FPS | 60.19 | 60.12 |
| p95 frame interval | 16.7 ms | 16.8 ms |
| Draw calls | 138 | 152 |
| Triangles | 87,286 | 108,706 |
| JS heap sample | 45.0 MiB | 47.1 MiB |

Reports: `docs/perf/street-life-after.json` and `street-life-npc.json`. NPC positions and
traffic presence change over time; the table is a bounded stationary sample, not equal
population counts or whole-city performance. The longer NPC action test loaded additional
face variants and measured 72.6 MiB JS heap, 174 calls and 136,793 triangles at a different
camera/player position. JS heap is not GPU memory. Existing Blender/glTF skinned-node
warnings remain; validation found no glTF errors in the four new models.

Implementation files: `avatar/realistic.ts`, `avatar/character.ts`, `avatar/npcIdentity.ts`,
`shop/Shopkeepers.ts`, `activities/DeliveryWorld.ts`, `ambient/StreetLife.ts`,
`ambient/AmbientTraffic.ts`, `ambient/trafficRoutes.ts` under `frontend/src/lib/game/`,
plus `CityEngine.ts`'s read-only airborne flag and `world/+page.svelte` integration.
The four model assets and their generator are additions; original player assets remain unchanged.

Four faces are a first step, not unlimited human diversity. Hair has the existing two base
styles; more authored hairstyles and age-specific assets remain future work. The bounded
population deliberately favours low-end gameplay over crowded streets.

## Completed checks and captured output

- `npm --prefix frontend test`: 277 Vitest tests across 39 files and four Node test files passed.
- `npm --prefix frontend run check`: no Svelte/TypeScript errors or warnings.
- `gltf-transform validate`: all four NPC GLBs load with no validation errors.
- `node frontend/tests/perf/npc-life.mjs`: separate NPC/player models, normal Space input,
  hop/landing, moving motorbike, moving bicycle and Low cleanup passed; no page/fallback errors.
- `node frontend/tests/perf/npc-shopping.mjs`: unforced storefront browsing and hand-held bag passed.
- `node frontend/tests/perf/street-life-play.mjs`: connected walk, greeting, photo download,
  Low limit and connection checks passed. This also observed a natural shopper on its route.
- Screenshots: `/tmp/ppg-npc-face.png`, `/tmp/ppg-npc-jump.png`,
  `/tmp/ppg-npc-bicycle.png`, `/tmp/ppg-npc-shopping.png`, `/tmp/ppg-street-life-npc.png`.

The frontend Docker build was rebuilt locally. Backend code/data schemas are unchanged;
backend tests were not repeated for this frontend-only increment. No changes were pushed.
