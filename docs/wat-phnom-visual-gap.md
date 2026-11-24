# Wat Phnom: visual gap and foliage cost correction

The user's screenshots demonstrate that the delivered scene is far below the reference's
art quality. Lighting tweaks and a favorable Riverside benchmark did not demonstrate
that a dense Wat Phnom view was visually convincing or fast enough.

## Changes

- Replaced solid crown cores and individual polygon leaves with fixed leaf-spray cutouts.
  Final budgets: rain tree **416 triangles**, slender tree **216**, shrub **60**.
- Added an original 512² alpha-masked leaf texture, its CC0 attribution, and a reproducible
  Python/Pillow drawing script. It is decorative original artwork, not a verified botanical
  model or an imported photograph.
- Kept existing instancing, material sharing, cached shadows, original avatar and OSM positions.
  Alpha-to-coverage smooths masked edges. Limited six sprays/clump avoids the overdraw of a
denser prototype; low polygon count alone is not proof of faster rendering.
- Performance mode now retains cheap ground colour variation and paving seams instead of
  turning grass/terrain into entirely flat colours.
- Fixed automatic quality fallback: slow-frame time previously accumulated and was then
  subtracted at nearly the same rate. Sustained ~20 FPS now builds a slow-frame debt; smooth
  frames recover it. One long pause is capped and cannot alone force a downgrade.
- Benchmark accepts full-HD/custom viewport and single-quality runs, records effective
  quality, and detects rendering errors rather than reporting FPS alone.

## Evidence and tests

The before sample at Wat Phnom used 1920×1080, real Intel integrated GPU, fresh accounts,
Morning (07:30), and eight seconds of idle plus eight seconds of running input. It measured
about **2.58 million triangles**, 21.5 FPS in the requested-High run (effective Low), and
23.8 FPS in Low. This reproduces the user's complaint more closely than the earlier
1280×720 Riverside sample. These are short samples on a shared laptop, not universal targets.

The first cutout prototype reduced triangle cost but was still too slow in High because of
alpha overdraw. The final reduced-layer revision's long benchmark was interrupted; that run
provides no valid final FPS result. Do not present prototype FPS as final performance.

A subsequent shorter **final Low-mode** run completed successfully at the same full-HD
resolution, spawn, morning preset and input duration: **53.4 FPS average**, 33.4 ms p95,
50.1 ms worst frame, 170 calls and 278,682 triangles. Effective quality was Low and there
were no reported render errors. Before Low was 23.8 FPS with about 2.58 million triangles.
This is a short measured improvement, not a stable city-wide 30 FPS certification; final
High-mode performance has not been remeasured after the last revision.
Raw reports: [before](perf/wat-phnom-foliage-before.json),
[final Low](perf/wat-phnom-foliage-final-low.json).

- Frontend check: no errors/warnings; 223 existing/current unit tests and both legacy files
  passed for the asset pass.
- Two new asset tests verify triangle budgets, MASK materials, texture presence, resolution
  and transparent gaps; all three initial cutout GLBs passed glTF validation.
- Two quality-fallback regressions pass, covering sustained 20 FPS and recovery from one hitch.
- Browser asset preview rendered the cutouts with no shader/page errors. Real gameplay
  screenshots were inspected; the architecture and ground still do not match the reference.

## Registration screenshot

Port 5199 was a temporary asset preview, subsequently stopped. It is not the supported
Docker game endpoint. On the local computer use **http://localhost:3000**. Its account
capabilities API responded 200 and browser benchmark accounts registered successfully there.
Do not send the user to Docker bridge IP 172.22.0.1 as their LAN URL. The current asset preview
was bound only to localhost and stopped after verification.

## Remaining art work

The delivered result is not photorealistic. Generic facades, basic trunks, sparse landscape
composition, approximate terrain and missing detailed landmark surroundings remain prominent.
Further progress needs geographically aligned landmark/stair/railing/building models and
better authored vegetation/material assets, reviewed in a single scene before city-wide rollout.
The concept image is not a surveyed map and is not used to invent coordinates or private layouts.

No GitHub push or new geographic import was performed.
