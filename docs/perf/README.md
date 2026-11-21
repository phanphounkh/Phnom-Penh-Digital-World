# Performance measurements

All numbers were measured on this development machine's **Intel Alder Lake-N integrated GPU**
(`ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (ADL-N)), Mesa)`), a low-end "ordinary
computer" chip. Settings: headless Chrome 157 rendering on the real GPU through ANGLE/Vulkan,
1280×720, devicePixelRatio 1, dev server. Each scene loads at a spawn point, stands still for
8 s, then runs (Shift+W) for 8 s while chunks stream. The frame times come from
`requestAnimationFrame`.

```bash
cd frontend
node tests/perf/measure.mjs            # vsync-capped (what players see) → JSON
node tests/perf/measure.mjs --uncapped # vsync off (headroom; see the caveat below)
node tests/perf/probe.mjs central-market   # per-frame CPU breakdown, draw calls, triangles
node tests/perf/ablate.mjs central-market  # toggle shadows/props/walls/... and compare
node tests/perf/tour.mjs artifacts         # GPU screenshots at set times of day
```

The scripts sign in a reusable `perfbot` account, so they don't hit the registration rate limit.

## Results: vsync-capped (what players see)

| Scene · quality | Phase 1: mean / p5 fps | Phase 2 first build | **Phase 2 final** (mean / p5 / worst frame) |
|---|---|---|---|
| Central Market · high, standing | 56.9 / 30 | 46.5 | **60.1 / 59.9 / 16.8 ms** |
| Central Market · high, running | 60 / 59.9 | 50.7 / 29.9 | **60.1 / 59.9 / 16.8 ms** |
| Wat Phnom · high, running | 60 / 59.5 | 42.6 / 20 | **60.1 / 59.5 / 16.8 ms** |
| Riverside · high, running | 60 / 59.9 | 60 / 59.5 | **60.1 / 59.5 / 16.8 ms** |
| Every scene · low | 60 | 60 | **60** |

p5 is the 5th-percentile frame rate. A worst frame of 16.8 ms means not one frame missed a
vsync while chunks streamed in. Raw data is in `phase1-baseline-gpu.json` and `phase2-gpu.json`.

Phase 2 per-frame cost (`probe.mjs`, high quality): simulation and streaming 0.4 ms;
`renderer.render` 3.8–4.2 ms; 170–195 draw calls; 50k–146k triangles. That leaves about 75 %
of the 16.7 ms budget spare.

## What fixed the Phase 2 regression

The first Phase 2 build added Blender props, landmarks, a facade shader, terrain and
signs, and dropped to 43–51 fps in dense areas at high quality. The ablation pinned the cost
on **shadows** (about 5 ms CPU per frame, plus GPU time), then props (about 3 ms):

1. **Cached shadow map.** `shadowMap.autoUpdate = false`. The shadow camera follows the player
   on a 12 m grid, and shadows re-render only when that cell changes, the light moves, or chunks
   or landmark models arrive. The avatar uses a contact blob instead of the shadow map.
   Snapping also stops shadow shimmer.
2. **Detail LOD.** Props, light pools and sign blades are hidden in chunks more than about 240 m
   away (160 m in performance mode). Landmark labels stay visible.
3. **Worker geometry.** Chunk fetch, JSON parsing and triangulation run in two Web Workers, with
   zero-copy transfer. The main thread assembles at most one chunk per frame.

## Caveat: uncapped numbers

`--uncapped` (`--disable-gpu-vsync --disable-frame-rate-limit`) shows GPU headroom
(`phase1-baseline-gpu-uncapped.json`: 90–780 fps). Its *worst-frame* figures are **not**
evidence of hitches. When the page submits frames faster than the GPU process presents them,
the driver periodically blocks for 200–400 ms. With vsync on, those stalls disappear entirely
(0 frames over 50 ms in the same scenes). Use the capped mode to judge smoothness.

## Gameplay polish: follow camera and see-through canopies

Same machine and settings. `master` (before) and the change (after) were served side by side
and measured back to back at the same spots, reached by in-game fast travel.

**Cost.** The camera placement went from 2.0–4.6 µs to 2.9–5.9 µs per frame. That was
measured in Node on Central Market's 1,216 real buildings over 200,000 orbiting frames at
7.5, 14 and 22 m zoom. The leaf shader patch was measured with a same-frame A/B render that
alternated the original shader, the patched shader with the fade off and the fade on
(`renderer.render` + `gl.finish`, median ms per render). Zoomed out over the Wat Phnom park it
measured 1.44 / 1.43 / 1.35 ms. Beside a tree with its canopy faded it measured
1.18 / 1.07 / 1.33 ms. Both differences are within noise. Whole-scene runs hold a median of
60 fps with p5 ≥ 59.5 in every scene, before and after. Occasional 100 ms–1.2 s stalls appeared
in both builds and tracked the machine's load, not the build.

**Obstruction.** Before → after:

| Scenario | Before | After |
|---|---|---|
| Building between camera and head, 92 Central Market street spots orbiting at 7.5 / 14 / 22 m (deterministic, Node) | 0.04–5.3 % of frames, at up to 56 of 92 spots | **0 %** |
| Avatar pixels visible, orbiting beside a Wat Phnom tree at default zoom (GPU render, mean) | 73.9 % | **91.2 %** |
| … samples where the avatar is hidden (< 10 % visible) | 22.8 % | **1.9 %** |
| Same, zoomed out: mean visible / hidden | 59.8 % / 33.1 % | **85.0 % / 3.2 %** |
| Running through the park: mean visible / hidden | 86.6 % / 9.0 % | **94.2 % / 1.3 %** |

The remaining hidden samples are mostly trunks, which stay solid on purpose.

## Not yet measured

* Real devices other than this machine: discrete GPUs, older laptops, phones (mobile defaults
  to performance mode).
* High-DPI screens (pixel ratio is capped at 1.5 in quality mode, 0.75 in performance mode).
* Multiplayer load (Phase 3).
