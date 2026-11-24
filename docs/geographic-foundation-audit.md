# Geographic foundation audit — 2026-11-24

Local branch: `milestone/geographic-foundation`. No push or merge was performed.
This is Milestone 1's audit and first safety improvement, **not** a completed city expansion.
Existing uncommitted avatar and graphics work was preserved on the branch.

Subsequent progress: [shared feature membership](geographic-ownership.md) adds the first
ownership prerequisite. The findings below describe the initial audit baseline.

## Repository findings

All requested geography paths exist. The repository contains 495 tracked/discoverable source,
documentation, test and asset paths excluding dependencies at audit time. Reviewed the geographic
pipeline, runtime boundaries, rendering/streaming, relevant gameplay modules, and test harnesses;
this was not a line-by-line verification of every file or every asset.

| System | Existing implementation | Limitation relevant to the mission |
|---|---|---|
| Data acquisition | `tools/gis/fetch_osm.py`: per-statement Overpass bounding boxes, complete member geometry, provenance manifest | One playable neighborhood snapshot; city places and city outline are not playable city-wide geometry |
| Coordinates | `geography/projection.py`, frontend `geo/projection.ts`: EPSG:32648, origin at Central Market, east +X, north −Z | Retain these coordinates; no reason to change projection |
| Import | OSM parsers, PostGIS upserts, clipped surfaces and roads, global OSM feature identities | Features have one `region_id`; adjacent datasets can compete for the same feature |
| Streaming | 200 m chunks; two workers, four concurrent requests, nearest-first loading, one assembly/frame, radius-based unloading and prop detail | `WorldChunk.key` is global but owned by one region; adjacent geographic boxes can share cells |
| Cache | HTTP ETag/max-age, loaded/pending chunk maps, failed-request retry | No bounded persistent offline chunk cache |
| Roads/navigation | Real OSM nodes, access/one-way tags, routing graph, vehicle kinematics | Graph rows and routing ownership remain region-scoped; no verified cross-region handoff |
| Buildings | Preserved footprints, height provenance, atlas facades, selective Khmer roofs | Most heights and all decorative facade appearance are estimates/procedural |
| Landmarks | Central Market dome and Wat Phnom stupa GLBs; real footprint overrides; procedural vihara roof | No complete verified registry/assets for all ten requested landmarks |
| Terrain | Shared Python/TS mound function and fixture for Wat Phnom | Approximate mound; otherwise flat, not surveyed elevation |
| Avatar | Existing realistic skeleton, motion clips, gait blending, IK, wardrobe, collision and contact shadow | Preserved; not replaced |
| Interiors | Eligible footprint-based buildings, worker-generated rooms, doors, nav/collision, light and interactive objects; shop counters | Fictional generated layouts, not real private interiors; no claim all requested showcase interiors were tested here |
| Multiplayer/social | Region rooms, AOI visibility, movement validation, chat, friends, blocks, mutes and reports | Region transition needs server validation and room handoff; proximity voice is absent |
| UI/maps | Minimap, location picker using MapLibre, place search, routes, interaction/chat/shop/wardrobe panels | Concept's full-screen landmark exploration map is not implemented as shown |
| Rendering | Shared/instanced GLBs, surface shaders, cached shadows, day/night, fog, sky/environment, limited local lights | Current Low/High only; no Medium preset. Riverside night screenshot is too dark under trees |

## Measured snapshot coverage

Reproducible report: [geographic-foundation-coverage.json](perf/geographic-foundation-coverage.json).

- One snapshot, OSM timestamp `2026-11-07T23:23:51Z`, 5,074 elements.
- Configured box: 2.7849 km²; 90 intersected 200 m chunk cells.
- 2,376 building footprints; raw parser height sources: 2,324 estimated, 48 levels, 4 explicit heights.
  These are before importer landmark overrides, hence differ from older imported-height counts.
- 787 roads; widths: 746 estimated, 38 derived from lanes, 3 explicitly mapped.
- 12 mapped water features intersect the box. This is a feature count, not proof of complete shoreline coverage.
- Box/city-outline intersection: 2.7849 / 688.4977 km² = **0.4045%**.
  This measures downloaded bounding-box coverage, not complete buildings, surveyed accuracy,
  current database imports, or the full administrative city's playable coverage.

Source: OpenStreetMap contributors, ODbL 1.0. The city boundary is the stored OSM administrative
relation, not independently certified official Cambodian survey data. No Overture or new official
dataset was downloaded, no new region was imported, and no coordinates were invented.

## First working change

`backend/app/geography/coverage.py` provides a read-only coverage audit and import preflight.
`backend/scripts/audit_geography.py` exposes it without requiring a database or internet connection.
`import_all` now runs preflight **before any database writes**, including the city import.

It rejects missing snapshots, mismatched bbox/count/timestamps, missing attribution,
duplicate identities, Overpass error responses, incomplete geometry and configured regions sharing
global chunk cells. The last check deliberately prevents unsafe expansion until canonical shared
chunk ownership is implemented. It does not make multi-region imports seamless by itself.

```bash
cd backend
.venv/bin/python scripts/audit_geography.py
.venv/bin/python scripts/audit_geography.py daun-penh-central --output /tmp/coverage.json
```

Tests: `tools/gis/tests/test_coverage.py` (offline unittest suite).
The benchmark now supports `--spawn riverside --fresh`, records source spawn and actual bootstrap
start, effective quality, frame times, draw calls, triangles, heap and renderer resource counts.
Fresh test accounts avoid benchmarking a resumed old location under a new landmark label.

## Current browser baseline

Raw results: [geographic-foundation-baseline.json](perf/geographic-foundation-baseline.json).
Headless Chrome, real Intel integrated GPU through ANGLE/Vulkan, 1280×720, DPR 1,
production website at localhost:3000, live time around 05:10 Phnom Penh. Eight-second idle and
eight-second Shift+W input samples. Both fresh starts matched the stored Riverside spawn:
11.57000 N, 104.93050 E → x 1019.43, z −49.49; `resumed=false`.

| Mode | Idle FPS | Input sample FPS / p95 frame / worst frame | Calls / triangles* | JS heap* |
|---|---|---|---|---|
| High | 60.1 | 59.9 / 16.8 ms / 50.1 ms | 38 / 131,158 | 52.3 MiB |
| Low | 60.0 | 60.1 / 16.7 ms / 16.8 ms | 38 / 131,158 | 34.2 MiB |

*Resource counts sampled after the input interval, not peaks. JS heap is Chrome's reported
JavaScript heap, not total computer RAM or GPU memory. Input is directed toward the river and
can be blocked by collision; these samples do not certify sustained cross-district running.
Screenshot: `/tmp/ppg-riverside-fresh.png` (not committed). Visually verified: loaded city HUD,
avatar, west-bank spawn facing the river. Dark avatar visibility remains a defect for the
later lighting pass. This short single-device benchmark is not a city-wide 30 FPS guarantee.

An earlier all-spawn benchmark reused a resumed account and was excluded from authoritative
district results. In that run a dense scene had a 150 ms worst frame; long frame spikes need
continued profiling rather than extrapolating from this favorable Riverside sample.

## Scalable expansion design and next slice

1. Keep global OSM identities and the current UTM grid. Add dataset membership separate from
   feature ownership; pruning a refreshed region must not remove another region's shared feature.
2. Give each global chunk one canonical payload assembled from the union of its source datasets.
   Deduplicate buildings by OSM identity; clip complete areas/roads once to canonical cells.
   Keep logical source polygons separate from chunk fragments and test seams/holes/shorelines.
3. Connect routing through shared source OSM node identities, with region-independent graph
   ownership. Do not join roads merely because projected endpoints are close.
4. Extend client chunk availability and collision limits to the union of imported adjacent
   regions; add multiplayer room transition/resume tests before enabling continuous travel.
5. Download one small adjacent Riverside extension using the existing fetcher after ownership
   is implemented. Keep its provenance/hash, validate complete river polygons and source roads,
   import into the test database first, and compare stable Daun Penh IDs/counts before live import.

The full ten-item playable showcase acceptance test (café, interior, full-screen map and verified
landmark navigation included) has **not** been completed by this audit slice.

## Validation

- Seven offline coverage/preflight regression tests passed.
- 25 existing backend geography/streetscape tests passed against the dedicated `_test` database,
  including import/re-import ID stability, real footprints, open spawn ground, projection and chunks.
- Frontend check: zero errors/warnings; 28 projection/chunk/collision tests passed.
- New Python files pass Ruff; benchmark JavaScript passes Node syntax check.
- Real browser benchmark and screenshot completed. No gameplay runtime code changed in this slice.

Milestone files: `backend/app/geography/coverage.py`, `backend/app/geography/importer.py`,
`backend/scripts/audit_geography.py`, `tools/gis/tests/test_coverage.py`,
`frontend/tests/perf/measure.mjs`, this audit, and the two small JSON evidence reports.
