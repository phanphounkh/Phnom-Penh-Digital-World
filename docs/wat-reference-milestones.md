# Wat Phnom reference-based increments

Two small, tested increments are implemented in the running localhost:3000 game: ground and
lighting refinement, followed by a bounded façade-geometry increment. This is not a completed
photographic reconstruction or a finished Wat Phnom vertical slice. No changes were pushed.

## Audit and three largest visual problems

All requested city, geography, avatar, building and GIS paths exist. The current architecture
was retained: PostGIS/OSM footprints and relative UTM48N coordinates → worker triangulation
and extrusion → chunk assembly and instanced props. The terrain is an existing cosine mound,
not a survey mesh. Avatars keep their existing GLBs, wardrobe, animation mixer and IK;
interiors keep their existing lazy generation, doorway clipping, collision and indoor camera.
Existing player vehicles, multiplayer sessions, emotes and audio remain in place.

The actual Wat Phnom baseline shows: (1) an under-detailed hill/ground surface, (2) coarse,
repeated trunks/crowns and leaf sprays, and (3) atlas-only building details. Existing ACES,
solar sky, fog, cached sun shadows and Low/Medium/High presets from the preceding pass were
reused. The reference photographs confirm mixed ground cover, shaded planting, weathered
masonry and projecting exterior details; they do not provide a precise elevation survey.

## References and provenance

[Photograph catalog](references/phnom-penh.md) and its machine-readable JSON record five
reviewed real photographs: three Wat Phnom views, a Daun Penh street and a Central Market
aerial. They include authors, reported capture dates, camera coordinates when provided,
licenses, source/original URLs, retrieval date, observations and reviewed-preview hashes.
Camera GPS is never substituted for a landmark's geographic anchor. Capture timezones and
current 2026 appearance are not independently verified. Missing coordinates remain null.
Photos stay outside Git and are used for study; no photographic pixels are runtime textures.
Other priority locations remain explicitly pending in the catalog.

## Milestone 1 — ground and evening rendering

- `frontend/src/lib/game/city/groundTexture.ts` (new): deterministic 256² packed ground
  artwork, with short interleaved fibres, normal slopes and roughness in four channels.
  One shared filtered texture, mipmaps, repeat wrapping and a 2 m visual repeat; no added blades
  or terrain triangles. This is original procedural artwork, dedicated under CC0-1.0.
- `materials.ts`, `surfaces.ts`, `CityEngine.ts`: grass/soil detail in every preset and shallow
  relief in Medium/High. Coarse soil tint is decorative; elevations, collision, mapped parks,
  roads, slopes and paths are unchanged. The texture is disposed with CityMaterials.
- `StreetLighting.ts`, `lighting.ts`: inactive local lights are removed from rendering;
  Medium uses at most two active lamp lights, High at most four. Lamp intensity and additive
  light pools are reduced to limit evening hot spots. No bloom or new post-processing.
- `groundTexture.test.ts` (new) and `StreetLighting.test.ts`: deterministic packed channels,
  bounded allocation, neutral normal averages, roughness bounds, inactive-light culling and
  the Medium light budget.

The first deployment passed frontend checks/tests and actual Wat Phnom movement/render checks
before work on the next increment. Short scene samples improved substantially in High, but
these shared-laptop measurements do not establish a universal speedup or city-wide target.

## Milestone 2 — first façade geometry increment

- `facadeRelief.ts` (new): modular raised window frames and projecting sills. The worker
  inverts each existing wall's UV-to-world transform, aligning trim with the current façade
  atlas even on rotated walls. This is original generic geometry, not a surveyed replica.
- `chunkGeometry.ts`: one merged trim batch per chunk; at most 48 window sets per chunk,
  eight per building and two per wall. No ground-storey trim; temples, Khmer-roof buildings,
  curated landmark models and buildings over 32 m are skipped.
- `assemble.ts`, `materials.ts`, `ChunkManager.ts`, `CityEngine.ts`: shared trim material,
  cached shadow eligibility, disposal and separate chunk-distance detail limits. Low hides
  trim; Medium/High use nominal 90/160 m detail radii padded by chunk coverage, not per-window
  distance. Geometry is generated once in workers, never rebuilt each frame.
- `facadeRelief.test.ts` (new): UV-plane alignment on straight/rotated walls, normals,
  unchanged wall geometry, depth/height bounds, triangle budget and ground/temple exclusions.

The existing GIS footprints, source heights and source/estimate flags are untouched. Trim
projects at most 0.19 m from the wall and starts above the ground storey; this changes visual
relief, not building locations or gameplay colliders. Balconies, roofs, custom doors and
accurate landmark architecture are not claimed complete.

## In-game verification and measurements

The comparison is at x 207, z −628, near the Giant Clock of Phnom Penh at Wat Phnom. Actual
baseline/after setup objects match: position/yaw, review camera, 1280×720 viewport and fixed
2026-11-24 07:30 Phnom Penh solar time. Native rAF/performance.now measure six seconds per
preset; only Date is overridden for the sun. The actual Intel ADL-N integrated GPU is used
through ANGLE/Vulkan. Requested modes stayed in their requested effective modes.

| Preset | Before FPS / p95 ms | Ground/light pass | Final FPS / p95 ms |
|---|---:|---:|---:|
| Low | 51.1 / 33.4 | 60.1 / 16.7 | 60.2 / 16.7 |
| Medium | 60.1 / 16.8 | 60.1 / 16.7 | 60.1 / 16.7 |
| High | 41.9 / 50.0 | 57.6 / 16.8 | 59.4 / 16.8 |

Final High: 263 draw calls and 288,095 rendered triangles, versus 259 and 277,535 before.
Final Low remains 259 calls / 277,535 triangles; Medium is 261 / 282,335. Loaded trim geometry
is separate from visible geometry: 53,880–66,840 trim triangles were resident across 20–25
chunk batches in these runs. Low hides it; CPU buffers can remain until chunks unload.

Main-page JS heap snapshots (before → final): Low 31,264,072 → 33,405,076 bytes; Medium
29,761,464 → 29,487,924; High 36,660,360 → 45,915,156. Garbage collection and loaded chunks
vary; these are not retained-memory or VRAM measurements and exclude worker heaps. The ground
atlas adds 256 KiB of texels before mipmaps. Results are short, vsync-limited scene samples
on a shared laptop, not certification of stable 60 FPS throughout the city.

A separate Medium night sample after warm-up measured 60.1 FPS / 16.7 ms p95 with two active
point lights. The first switch to a newly compiled night shader can hitch; this warm sample
does not measure transition cost. The avatar remained readable and movement worked.

- Initial baseline: 234 Vitest tests plus all three Node test files passed.
- Milestone 1: 237 Vitest tests plus all three Node test files passed.
- Final: 240 Vitest tests in 29 files plus all three Node test files passed; final targeted
  ground/trim/light tests also passed. Svelte/TypeScript check: zero errors/warnings.
- Docker frontend built and healthy. Browser runs reported no page/shader errors, stayed
  connected to multiplayer, retained exact comparison coordinates and completed movement.
- QA uses the existing collision-aware navigator to approach the frontage. The road-only
  approach did not reach it directly; product route-approach behavior needs follow-up.
- A full multi-client, shopping, interior and vehicle browser suite was not repeated in this
  pass. Relevant existing geometry, projection, collision, avatar, vehicle and interior unit
  tests passed; no claim is made that every gameplay interaction was visually retested.

Raw reports: `docs/perf/wat-reference-{baseline,surfaces,architecture,night}.json`.
Actual application screenshots, outside Git:

- `/tmp/ppg-wat-baseline-medium.png` — before, southern hill frontage.
- `/tmp/ppg-wat-architecture-medium.png` — final, matching camera/location/time/viewport.
- `/tmp/ppg-wat-architecture-high.png` — final High.
- `/tmp/ppg-wat-architecture-close.png` — real raised trim close view, supplementary camera.
- `/tmp/ppg-wat-architecture-night.png` — night view after warm-up.

QA tools: `frontend/tests/perf/wat-phnom.mjs` and `facade-close.mjs`. The close view changes
only the review camera in the actual world; it does not substitute a studio scene or image.

## Remaining work and next priority

The hill shape is still approximate. Stair/naga geometry, the actual Wat Phnom temple, gardens
and retaining walls need measured alignment and curated models. Trees still have conspicuously
simple crowns/branches; grass remains a surface approximation rather than geometry. Existing
façade styles are estimated; this pass does not identify each private building from photographs.
NPC populations, traffic, new furniture, building entrances and animation polish were not added.

Next separate milestone: rebuild and validate three vegetation variants against the Wat Phnom
photos, with LODs and overdraw budgets. Then refine the verified landmark/stair surroundings
and batch balcony/awning components where appropriate. Continue actual gameplay testing and
performance measurements before expanding the successful components to more districts.
