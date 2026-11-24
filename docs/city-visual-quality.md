# Shared city material and nighttime visibility pass

The reference image is an art-direction target, not source geography or evidence of
implemented photorealism. Changes apply wherever the existing shared city materials render;
they do not expand geographic coverage or replace the existing avatar.

## Changes

- `city/surfaces.ts`: bevel and fine-grain shading on paving/plazas/sidewalks;
  spatial roughness variation on stone and asphalt. These are procedural decorative
  surface treatments, not claims about surveyed pavement materials or weather.
- `city/materials.ts`: less uniformly bright windows, varied decorative room warmth and
  curtain shading, glossy glazing at night. Illumination is not real occupancy data.
- `city/lighting.ts`: stronger cool sky fill and warmer ground bounce so unlit paths remain readable.
- `city/AvatarLighting.ts` and `CityEngine.ts`: soft, camera-facing fill in character material
  shaders fades out by day/indoors. This is a readability aid, not a real lamp.
- `avatar/realistic.ts`: existing characters receive the shader fill; models,
  skin/clothing choices, skeletons and animations are preserved.
- `tests/perf/measure.mjs`: `--time night|sunset|noon|morning|live` enables repeatable lighting
  for before/after comparisons. `--fresh` avoids resuming an old spawn location.

No additional surface geometry, large textures, post-processing or scene lights.
Performance mode still skips expensive surface detail; both presets receive the visibility fix.

## Checks

Frontend check: zero errors/warnings. All 223 Vitest tests and both legacy test files passed.
The new character-fill test checks material isolation, cloned materials, indoor/day fading and disposal.
A Chrome render of the shared surfaces completed without shader/page errors.

## Deployed browser comparison

Frontend container rebuilt and healthy. Chrome on the actual Intel integrated GPU,
1280×720, fresh accounts, verified Riverside spawn, fixed Night preset (21:00).
Eight seconds idle plus eight seconds running input toward the river; collision can block
forward travel, so this is not a long-distance streaming benchmark.

| Mode | Before input FPS / p95 | After input FPS / p95 / worst | After calls / triangles |
|---|---|---|---|
| High | 60.1 / 16.7 ms | 60.1 / 16.7 ms / 16.8 ms | 38 / 131,158 |
| Low | 60.1 / 16.7 ms | 59.4 / 16.8 ms / 33.4 ms | 38 / 131,158 |

After-sample reported JS heaps were 43.2 MiB (High), 38.0 MiB (Low), not total RAM/VRAM
or peaks. No render/page errors were recorded. Calls and triangles were unchanged for
this view. The low-mode frame spike and short samples preclude a whole-city FPS guarantee.
Raw evidence: [before](perf/city-quality-before.json), [after](perf/city-quality-after.json).

Screenshots are local review artifacts, not new game assets:
`/tmp/ppg-city-quality-before.png` and `/tmp/ppg-city-quality-after.png`.
Visual review confirms substantially better avatar and ground readability beneath tree cover;
the view remains far less detailed than the supplied reference.

## Limits

This is a shared rendering pass, **not an exact match** to the reference across Phnom Penh.
Current coverage is still the imported Daun Penh neighborhood. Detailed recognizable buildings,
individual landmarks, richer vegetation assets, pedestrian activity and streetscape modelling
remain separate work. Keep those assets tied to verified geographic sources.

No GitHub push was performed. Existing geographic foundation changes remain on the local branch.
