# Street material realism pass — 2026-11-24

The existing city rendering gains more convincing façades and street surfaces, including
Performance mode. No mapped footprints, coordinates, terrain meshes, building collisions,
interior layouts, avatar assets, vehicle assets or geographic coverage change in this pass.

## Changes

- `frontend/src/lib/game/city/facadeDetail.ts` adds original deterministic canvas artwork:
  shaded glazing, curtain folds, suggested roofline reflections, louvred shutters, paint grain,
  fabric shading, shelf details, and smaller irregular balcony plants. Existing six bay styles
  and their positions remain compatible with the atlas masks and floor heights.
- `materials.ts` upgrades the façade atlas from 768×128 to 1536×256, keeps glazing neutral
  instead of tinting it by the wall colour, and uses a matching height atlas for shallow
  window recess shading in Quality mode. These are bump normals, not physical extrusions.
- `surfaces.ts` retains staggered pavers and tile variation in Performance mode. A shared
  repeatable 256×256 grain texture provides filtered asphalt and soil detail instead of
  repeated fragment-noise calculations. The grain texture is generated once on the CPU.
- `lighting.ts` reduces daytime ambient fill in Performance mode for clearer orientation
  and material contrast. Night ambient fill and Quality-mode lighting remain as before.
- `CityEngine.ts` supplies the same shared grain texture to the existing ground material.
- All new textures are disposed with CityMaterials. No extra building meshes or draw calls;
  textures add some memory cost. Generated canvases are runtime resources, not large Git assets.

## Provenance and limits

Atlas artwork, window depths, shop shelving, wall weathering, reflected silhouettes and
paving patterns are fictional procedural decoration. They are not surveys, photographs,
verified private interiors or accurate reflections of nearby buildings. Existing geographic
geometry is untouched. Nearby shop openings continue to use the existing doorway uniforms.
This is an incremental visual improvement; the city still needs more authored 3D façade
geometry, accurate landmark assets, and additional environment detail for photographic realism.

## Validation

- Full frontend `npm test`: 230 Vitest tests passed, plus all three Node test files.
- `npm run check`: zero errors, zero warnings.
- Frontend Docker build succeeded; local frontend healthy at localhost:3000.
- Browser performance comparison: fresh test accounts at Central Market, same noon preset,
  Performance mode, 1280×720; 8 s standing followed by 8 s running, one browser at a time.
  Renderer: Intel ADL-N integrated graphics, ANGLE/Vulkan, Mesa. Vsync capped around 60 FPS.

| Sample | Before | Final |
|---|---:|---:|
| Standing average FPS | 59.0 | 60.1 |
| Running average FPS | 59.6 | 60.1 |
| Standing/running p95 frame interval | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
| Final frame draw calls | 406 | 406 |
| Final frame triangles | 106,282 | 106,282 |
| Loaded chunks | 18 | 18 |
| Renderer geometry objects | 289 | 289 |
| Renderer textures | 58 | 60 |
| Sampled JS heap | 50,243,561 bytes | 45,397,139 bytes |

Heap readings depend on garbage collection and are not a memory-saving claim. Texture and
geometry counters are object counts, not GPU memory bytes. One scene and short capped
samples do not establish city-wide performance or a guarantee for other machines.

Results: `docs/perf/street-materials-before.json`, `street-materials-final.json`.
Screenshots: `/tmp/ppg-street-before.png`, `/tmp/ppg-street-final.png`.
Close review screenshots: `/tmp/ppg-street-performance-midday.png` and
`/tmp/ppg-street-quality-night.png`; visually inspected after rendering.
Browser material regression: `node frontend/tests/perf/street-materials.mjs http://localhost:3000`.
All four preset/time cases passed with zero WebGL or page errors; results are in
`docs/perf/street-materials-smoke.json`. It checks real atlas pixels/masks, height ordering, texture dimensions/wrapping, reversible
registration of a doorway owner, both graphics presets at midday/night, and WebGL/page errors.
It does not claim a complete interior or geographic correctness test.

Next: add nearby façade geometry in controlled batches, improve visible roadside vegetation,
and work on a geographically verified riverside showcase. Preserve performance budgets and
use separate milestones for authored landmarks and further data imports.
