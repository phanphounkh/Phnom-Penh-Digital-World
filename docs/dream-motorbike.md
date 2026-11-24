# Dream-style motorbike replacement

The old generic motorbike mesh is replaced at the same GLB URL, so parked, owned and
remote motorbikes use the new exterior without deleting vehicles or migrating their data.
The bicycle and avatar assets are unchanged by this work.

## Appearance and scope

Original procedural geometry follows the supplied Dream 125 reference: curved black
step-through panels, long saddle with piping, gold/ivory side graphics, 36 crossed spokes
per wheel, drum hubs, engine fins and case bolts, twin rear springs, chrome exhaust and
heat shield, curved mudguards, front carrier, rear grab rail, rectangular headlamp,
amber indicators, mirrors, brake levers and a small analogue instrument face.

This is a recognizable game approximation, not OEM CAD, measured manufacturer dimensions,
or a claim of photographic fidelity. Existing 1.24 m gameplay wheelbase and rider anchors
are retained. The black panels receive a subtle tint from the saved vehicle colour.
The gauge is decorative; turn signals are decorative; the `PPW 125` plate is fictional.
No photographic texture, third-party mesh or paid asset is included.

## Implementation

- `tools/blender/generate_vehicle_assets.py`: reproducible motorbike-only generation;
  rounded lofts and curved shield/fenders, named steering/wheel nodes, rider anchors.
- `frontend/static/models/vehicles/motorbike.glb`: Meshopt-compressed replacement.
- `frontend/src/lib/game/vehicles/VehicleModels.ts`: clone and tint the black panel material
  per vehicle, preserving per-instance disposal and existing light materials.
- `frontend/tests/vehicle-asset.test.js`: loads the compressed file with the real Three.js
  loader, checks size/triangle budgets, ground contact, scale, wheelbase and steering hierarchy.
- `frontend/tests/perf/dream-motorbike.mjs`: real browser mounting, steering, wheel motion,
  engine media playback, dismount/parking, close screenshot and frame-time sample.

Hands now follow the steering assembly. Existing controls, speed limits, collisions,
engine sounds, ownership and multiplayer vehicle types are retained.

## Validation (2026-11-24)

- 17,839 triangles, 29 mesh primitives, 175,896-byte compressed download; no texture maps.
- Full `npm test` passed (Vitest plus all three Node test files); this includes
  three asset contract tests and twelve existing vehicle logic tests.
- Svelte check: zero errors/warnings. GLB validator: zero errors/warnings; informational
  notices include the validator not decoding Meshopt. The Three.js loading test does decode it.
- Local Docker frontend rebuilt successfully and healthy at `http://localhost:3000`.
- Browser gameplay at 1280×720 passed with zero page errors: acquire, mount, drive, steer,
  spin wheels, play motorbike media and park. Screenshot: `/tmp/ppg-dream-riding.png`.
- Short stationary sample at Central Market: 481 frames over 8.004 s, 60.09 FPS average,
  16.8 ms p95 frame interval. This is one local scene/sample, not a city-wide performance
  guarantee. Renderer counts and memory object counts are in the JSON; they are not byte
  measurements of RAM or VRAM. No claim is made about performance on other devices.
- Results: `docs/perf/dream-motorbike-smoke.json`.

Reproduce generation using the motorbike-only command in `tools/blender/README.md`.
The optional review blend and CPU studio renders remain outside Git under `/tmp`.
