# FTB daylight graphics — first implementation milestone

The rendering foundation has been improved and deployed locally. This completes the audit
and first daylight/preset step, not the entire requested boulevard or photographic realism.
Existing uncommitted project work was preserved. Nothing was pushed.

## Audit and reusable systems

All requested paths exist. `CityEngine.ts` creates the renderer, solar lighting, camera and
terrain; `lighting.ts` already supplied ACES exposure, hemisphere/sun lighting and an optional
cached sky PMREM. `ChunkManager.ts` streams 200 m chunks through workers; `chunkGeometry.ts`
extrudes GIS footprints, builds road ribbons and produces prop transforms; `assemble.ts`
creates meshes and instanced props. `materials.ts`/`surfaces.ts` supply the existing atlas,
procedural surfaces, window illumination and doorway clipping. `props.ts` shares GLB geometry,
materials and textures. `terrain.ts` mirrors backend mound heights.

`buildings/` retains generated and authored interiors, doors, furniture, collision and indoor
camera handling. `avatar/` retains the existing realistic character, wardrobe, clips and IK.
`backend/app/geography/` imports source footprints into PostGIS and publishes relative UTM48N
world metres (x east, z south); unknown widths/heights are labelled estimates. No geographic
coordinates, footprints, heights, road networks, avatar assets or gameplay protocols changed.

Principal visual gaps: shallow atlas-only façades; repeated tree crowns and simplified
branches; grass without close-range vegetation; no daytime clouds; an all-or-nothing shadow
preset. An additional bug kept already-loaded chunks from casting shadows after leaving Low.
The baseline desktop default was High (2048² cached shadows, 420 m stream radius); Low used a 0.75 pixel ratio with sun shadows disabled.
The first pass addresses lighting and shadow budgets. The geometry gaps remain visible.

## Code changed in this pass

- `city/DaylightClouds.ts` (new): deterministic 128² packed density texture, slowly moving
  cloud layer integrated into the existing atmospheric sky draw call; restrained clear-weather
  blue grading, sunset warmth and night fade. Sky reflections share the density uniforms.
- `city/quality.ts`: reusable Low/Medium/High budgets and gradual automatic fallback.
- `city/CityEngine.ts`: explicit sRGB output, existing ACES retained, preset integration,
  conservative desktop default, tighter shadow bias, fog budgets, cloud updates and cleanup.
- `city/lighting.ts`: shared sky/cloud environment rendering and Medium daytime fill so shaded
  streets remain readable without the High preset's environment map.
- `city/shadows.ts` (new), `ChunkManager.ts`, `assemble.ts`, `props.ts`: retain shadow-caster
  eligibility and restore loaded casters on preset changes, including late-loaded landmarks.
- `city/materials.ts` and `assemble.ts`: instanced, low-opacity contact patches at existing
  tree bases. At most 128 per chunk; omitted on raised terrain to avoid floating flat decals.
  These are ambient-contact approximations, not accurately projected canopy shadows.
- `routes/world/+page.svelte`: retain the HUD, add Balanced between Performance and Quality;
  desktop starts in Balanced, touch/software rendering stays conservative.
- `city/daylight.test.ts` (new): density bounds/determinism, night fade, texture disposal,
  preset budgets, fallback and restoration of eligible casters without making roads cast.
- `tests/perf/daylight.mjs` (new): actual game capture, foot-route traversal, caster checks,
  three-preset sampling, native frame timing, heap sampling, night screenshot and movement.
- `tests/perf/dream-motorbike.mjs`: wait for the asynchronous garage card before selecting
  Ride/Walk there; used for the driving/audio regression.

Paths above are relative to `frontend/src/lib/game/` except the route and test paths, which
are relative to `frontend/`. Existing avatar, driving, bicycle, shop and multiplayer code is
reused. The extra shared density texture and sun-shadow render targets are explicitly freed.

## Presets

| Setting | Low / Performance | Medium / Balanced | High / Quality |
|---|---|---|---|
| Maximum pixel ratio | 0.75 | 1.0 | 1.5 |
| Cached sun shadows | Off | 1024² over 96 m | 2048² over 150 m |
| Stream radius | 300 m | 340 m | 420 m |
| Prop detail radius | 160 m | 180 m | 240 m |
| Full procedural surface relief / sky environment | Off | Off | On |

Shadows remain cached, not rebuilt every frame. Sustained low FPS steps High → Medium → Low.
These are budgets, not performance promises. No expensive post-processing was added.

## Actual comparison and measurements

The game itself identifies the supplied position as Kramoun Sor Street (Street 114), near
Foreign Trade Bank of Cambodia. The comparison uses x −16, z −271, yaw 0; 1672×941 viewport;
camera (−7, 2.7, −282), target (−16, 1.6, −253), FOV 60°; 2026-11-24 16:42 Phnom Penh time.
Before/after JSON equality checks confirm those inputs match exactly. The avatar travelled
through the real foot-route API before capturing. No reference-image pixels were used.

| Short stationary sample | Before | Final |
|---|---:|---:|
| Low FPS / p95 interval | ~62.4 / ~19 ms † | 60.0 / 16.7 ms |
| Medium FPS / p95 interval | Not available | 60.0 / 16.8 ms |
| High FPS / p95 interval | ~45.9 / ~71 ms † | 49.0 / 33.4 ms |
| Low draw calls / triangles | 364 / 117,856 | 366 / 119,156 |
| High draw calls / triangles | 376 / 126,152 | 378 / 127,452 |
| Loaded chunks / geometry objects | 32 / 548 | 32 / 548 |
| High texture objects | 93 | 94 |

† The initial baseline used Playwright's fixed-clock instrumentation, which quantizes RAF
intervals. The final test freezes **only Date for the solar clock** and uses native rAF and
performance.now. The timing figures are therefore not a controlled speedup comparison;
no FPS improvement is claimed. Screenshots still match location, camera, solar time and
viewport. Final native samples cover 8 seconds per preset on Intel ADL-N integrated graphics
through ANGLE/Vulkan. Background desktop activity and live players can affect results.

Final sampled JS heap: Low 40,365,536 bytes, Medium 51,523,828 bytes, High 47,380,124 bytes,
from CDP Runtime.getHeapUsage. Baseline heap was unavailable. GC timing varies: no heap-saving
claim is made. Geometry/texture counters are object counts, not VRAM bytes. The cloud atlas
adds 64 KiB of raw texels before mipmaps; Medium uses one quarter of High's shadow-map pixel
count. Actual GPU byte consumption was not measured. No city-wide 30 FPS guarantee is made.

## Verification and screenshots

- Before changes: existing 230 Vitest tests plus all three Node test files passed.
- Final: 234 Vitest tests across 27 files, plus all three Node test files passed.
- Svelte/TypeScript check: zero errors, zero warnings. Docker frontend built and healthy.
- Live browser: three requested presets remained in their requested effective modes; Low
  disabled all 500 eligible caster objects; Medium/High restored all 500, including loaded chunks.
  Real multiplayer connection stayed open, native-timer route traversal logged zero server
  corrections, the avatar moved over 6 m in the final input test, and page/shader errors were
  empty. Night test confirmed daylight clouds fade to zero and the avatar stays visible.
- Separate real driving test passed: acquire motorbike, mount, steer, spin wheels, play engine
  media, brake and park, with no page errors. A full multi-client, shopping/interior or bicycle
  browser suite was not rerun in this rendering milestone; relevant existing unit tests passed.

Actual application screenshots, outside Git:

- Before High: `/tmp/ppg-daylight-before-quality.png`
- After High: `/tmp/ppg-daylight-after-quality.png`
- After Medium: `/tmp/ppg-daylight-after-balanced.png`
- Before/after Low: `/tmp/ppg-daylight-before-performance.png`, `/tmp/ppg-daylight-after-performance.png`
- Night: `/tmp/ppg-daylight-after-night.png`

Raw results: `docs/perf/ftb-daylight-{before,after,driving}.json`.
Reproduce the current build's checks with `node frontend/tests/perf/daylight.mjs after` and
`node frontend/tests/perf/dream-motorbike.mjs http://localhost:3000`. The harness uses hidden
QA accounts and a 240-second deadline; it does not move the player's existing account.

## Visual assessment and next work

| Requested aspect | Current outcome |
|---|---|
| Lighting | Daylight clouds, clearer sky, more useful preset/shadow budgets; Medium shade readable. |
| Buildings | Existing footprint geometry retained; façades still mostly flat atlas decoration. |
| Trees | Existing rain/palm/slender variants retained; contact improved, crowns/branches not rebuilt. |
| Ground | Existing grass/paving retained; near-grass detail remains insufficient. |
| Streets | Existing mapped placements retained; improved shadow switching, no new surveyed street detail. |
| Avatar | Existing model, wardrobe, rig and contact shadow preserved; daylight/night movement checked. |
| Overall quality | A rendering foundation improvement; still far from the photographic target. |
| Performance/memory | Final native samples above; small draw/triangle/texture overhead, no new huge assets. |

Next separate changes: improve three tree variants and their LODs, add low-cost near grass,
then batch nearby façade frames/awnings/balconies without changing GIS footprints. Traffic,
NPCs, additional street furniture and a complete polished vertical slice are still pending.
Night lamp hot spots, cloud billow detail and shadow-range transitions also need further art
polish. No invented towers or landmarks were added to imitate the reference composition.

## Asset provenance

The new runtime cloud density artwork is original procedural work, dedicated under CC0-1.0.
Tree contact shading reuses the existing original radial gradient. No external photos, HDRIs,
models, paid APIs or downloaded textures were added. The atmospheric Sky implementation is
from the existing Three.js dependency, whose MIT license remains intact. Clouds and contact
patches are fictional visual effects, not geographic or live-weather observations.
