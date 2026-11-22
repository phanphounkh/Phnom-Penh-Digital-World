# Environment and gameplay audit (Phase 0) and the first environment pass

Audit date: 2026-11-22. Machine: Intel Core 3 N355 with integrated Intel graphics (Mesa,
ANGLE/Vulkan in Chrome), 7.5 GB RAM, no dedicated GPU. Branch `feature/environment-polish`,
stacked on `feature/realistic-avatars`.

## What exists and works (verified in the code and in the running game)

| Area | Implementation | State |
|---|---|---|
| Rendering | Three.js r180, one `WebGLRenderer`; ACES tone mapping; a cached, grid-snapped shadow map (re-rendered only when the window moves or the world changes) | Works; 60 fps (vsync cap) at every measured district on the iGPU |
| World data | OSM chunks from the API, built in **2 Web Workers** (`chunkGeometry.ts`), assembled one per frame (`assemble.ts`, `ChunkManager.ts`); detail LOD hides props beyond 240 m (Quality) or 160 m (Performance) | Works |
| Buildings | Footprints extruded to OSM heights; vertex colours from a Phnom Penh palette; facade shader with a window bay and a shopfront bay, plus night glow; Khmer tiered roofs on temples | Works, but repetitive: every building had the same window |
| Roads | Ribbons for asphalt, sidewalks, paths, and dashed centre lines | Works, but flat colours: no kerbs or crossings, even though OSM crossings are in the data |
| Vegetation | 3 Blender tree species, instanced, at OSM trees and in parks | Works, but faceted, geometric crowns |
| Lighting | Real sun position over Phnom Penh, presets, `Sky` shader, fog, hemisphere light, night glow and lamp light pools | Works; the noon sky was washed out to white |
| Camera | Third-person orbit, pull-in when a wall blocks the view, terrain clamp | Works; smoothing and tree fading are on the unmerged `feature/gameplay-camera-polish` branch |
| Character | Walk 2.6 m/s, run 6.5 m/s, circle collision with sliding and sub-steps, walking autopilot; realistic avatars with clip animation (this work) | Works; **no jump or gravity** (the terrain is mounds, not cliffs) |
| Vehicles | Bicycle and motorbike: kinematic model, lean, chase camera, routing on the OSM road graph, parking; IK riders | Works; mounting is instant, with no mount or dismount animation |
| Interaction | Shops (walk-in doorways, shelves, cart), vehicles (`F` ride/park, `V` garage), emotes (`1`–`4`), chat (`Enter`) | Works; keys differ per feature (there is no single "press E" pattern) |
| HUD | Location card (shows raw coordinates), minimap, emote bar, nearby/world chat, online and fps badges, settings (Quality/Performance, time of day, avatar style) | Works; coordinates and fps are developer information |
| Audio | None in the city (only the legacy `/mall` has sound) | Missing |
| Ambient life | No NPC pedestrians or traffic ("no fake crowds" was a design principle) | Missing |

## Bugs and problems found

* `tools/blender/generate_avatars.py` has a long pasted prompt in the middle of a line (line 162), so it can't run. This has been there since the first commit.
* The `Sky` shader used turbidity 7 and rayleigh 1.4, so the noon sky renders almost white.
* Unmapped land (most of the open ground, including the Riverside promenade) was one flat beige plane.
* OSM `highway=crossing` nodes reached the client but were never drawn.
* Flaky end-to-end tests under software rendering (1–5 fps): the phase 5 braking check, and slow first-load shader compilation.

## Performance baseline (before this pass)

The same views were captured with `env-shoot.mjs` (a scratch script modelled on `tests/perf`) at 1280×720 on the iGPU:

| District | fps (mean / p5) | CPU render | Draw calls | Triangles |
|---|---|---|---|---|
| Central Market, street to overview | 60 / 59.5 | 3.8–4.8 ms | 82–161 | 53–62 k |
| Riverside | 60 / 59.9 (when the machine is not loaded) | 2.0–3.4 ms | 42–95 | 32–43 k |

There is a lot of headroom, so the most visible gains come from **better shading of the surfaces
that fill the screen** (ground, roads, facades, trees), not from more geometry.

## Recommended order

1. **Done in this pass:** the three highest-impact visual fixes: surfaces and ground, vegetation, and lighting and sky; then facades.
2. **Riverside vertical slice:** street furniture (benches, bins, bus stop, café tables, bicycle racks) placed by rule on the quay, plus real kerb geometry.
3. **Graphics presets:** LOW/MEDIUM/HIGH with conservative auto-selection (today there is Quality/Performance plus an automatic drop to Performance).
4. **Camera and movement:** merge `feature/gameplay-camera-polish` (camera collision and smoothing, see-through canopies), add jumping and gravity, and a shoulder camera option.
5. **Interaction and HUD:** one "press E" interaction pattern, a developer overlay for coordinates and fps, chat timestamps and collapsing.
6. **Ambient life:** sidewalk pedestrians and route-following traffic near the player only.
7. **Audio:** footsteps, bicycle, traffic, birds and café ambience, with volume settings.

## First environment pass: what changed

The chosen district for the vertical slice is **Sisowath Quay Riverside**: a promenade along the
Tonle Sap with shade trees, cafés and wide walkways. The changes are global (shaders and assets),
and they were checked at Riverside and at Central Market.

| Change | Where |
|---|---|
| Surface detail from world position, with no textures: stone pavers, sidewalk pavers with a pale kerb strip, asphalt grain, stains and patches, gutters with drain grates, patchy grass, animated river ripples | `city/surfaces.ts` (one shader program for all surfaces), `materials.ts` |
| Unmapped ground: 30–60 m patches of packed earth and dry and green grass instead of flat beige | `surfaces.ts` (`ground`), `CityEngine.ts` |
| Zebra crossings at OSM crossing nodes, across the nearest carriageway | `chunkGeometry.ts` (`crossings`) |
| Road ribbons carry across/along metres and width, so the shader knows where kerbs and gutters are | `chunkGeometry.ts`, `assemble.ts` |
| Facades: 6 bays instead of 2 (modern, colonial louvred shutters, balconies with railings, sun louvres with AC units; open shops and café fronts with striped awnings), picked per building and varied per bay; street grime, rain streaks, and glass that reflects the sky | `materials.ts` |
| Trees rebuilt from many leaf clumps with bent normals and baked occlusion (one leaf material per tree); a new shrub in parks and temple grounds; per-tree tint | `tools/blender/generate_city_assets.py`, `props.ts`, `chunkGeometry.ts` |
| Sky: clearer and bluer; sky-based image lighting (an environment map regenerated only when the sun moves noticeably); warmer golden hour | `lighting.ts`, `CityEngine.ts` |
| Performance mode: surface detail and the environment map switch off (lowest cost and fastest start without a GPU) | `CityEngine.applyQuality` |

Measured after the pass, with the same views (see `docs/perf/README.md`): still 60 fps (p5 ≥ 59.5)
at both districts. CPU render time is unchanged within noise (1.5–2.1 ms at Central Market after
merging the surface shaders). Draw calls change by ±3. Triangles rise 1–6 % in the city centre and
26–34 % at Riverside (fuller trees, shrubs). There are 26–28 shader programs instead of 19–21.
