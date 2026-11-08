# Geographic data: sources, coverage and accuracy

## Sources

| Dataset | File | OSM data timestamp | Elements |
|---|---|---|---|
| Daun Penh neighbourhood (roads, buildings, areas, POIs, trees, lamps) | `tools/gis/data/osm/neighborhood-daun-penh-central.json` | 2026-11-07 23:23 UTC | 5,074 |
| Phnom Penh places (khans, villages, neighbourhoods, markets, attractions) | `tools/gis/data/osm/city-places.json` | 2026-11-07 22:31 UTC | 425 |
| Phnom Penh administrative boundary (admin_level 4) | `tools/gis/data/osm/city-boundary.json` | 2026-11-07 22:32 UTC | 1 relation |

All data comes from **OpenStreetMap via the Overpass API** and is licensed under the
**Open Database Licence (ODbL 1.0) — © OpenStreetMap contributors**. Attribution is shown on
the welcome page, the location picker, the in-world HUD and the About page. `manifest.json` next
to the snapshots records each query and fetch time.

The base map in the location picker uses **OpenFreeMap** vector tiles (OpenMapTiles schema,
OSM data). The style URL is configurable with `PUBLIC_MAP_STYLE_URL`. If it is unreachable, the
picker falls back to our own data: the city outline, the playable area and the spawn markers.

## Playable area

`daun-penh-central`: bbox south 11.5650, west 104.9165, north 11.5790, east 104.9330
(about 1.8 × 1.6 km, 2.8 km²). It covers Phsar Thmei (Central Market), Wat Phnom, Canadia
Garden, Sisowath Quay and the riverside north of the Royal Palace, plus part of the Tonle Sap.

Imported (2026-11-08):

| Table | Rows | Notes |
|---|---|---|
| `buildings` | 2,376 | footprints, including multipolygons with courtyards, and one stupa mapped as a tower |
| `roads` | 787 | trunk → footway; 211 of 213 named roads have an English name |
| `land_areas` | 164 | grass, parks, parking, water, plazas, pitches, temple grounds, wetland |
| `landmarks` | 955 | named POIs; 536 linked to the building that contains them |
| `street_features` | 300 | mapped trees (incl. sampled tree rows), lamps, signals, crossings |
| `places` | 405 | city-wide search index (khans, villages, markets, hospitals…) |
| `world_chunks` | 90 | 200 m chunks with roads, buildings, areas, landmarks, furniture and signs |
| Phnom Penh boundary | 689 km² | the official relation (published figure ≈ 679 km²) |

## Accuracy and what is estimated

| Attribute | Real (OSM) | Estimated / generated |
|---|---|---|
| Road centrelines, names, one-way | ✔ | |
| Road width | 3 roads tagged with `width` | **Estimated** for the rest: 38 from `lanes` (3.25 m/lane + 1 m), the remainder from road class. Each row records `width_source`. |
| Building footprints | ✔ | |
| Building height | 4 with `height`, 48 with `building:levels` | **2,323 estimated** (97.8 %), from building type or a stable per-building value of 2–5 storeys. `height_source` marks every building. |
| Building colour, windows | | **Generated**: palette and window texture are decorative. |
| Trees in parks | 300 mapped point features | **Generated**: extra park trees are placed procedurally, deterministically (~1 per 140 m²). |
| Sidewalks, lane markings | | **Generated** from the road class. |
| Terrain | | **Flat**, except Wat Phnom's hill (below). |
| Landmark architecture | | Phsar Thmei's dome and Wat Phnom's stupa are **Blender models placed on the real footprints**. Temples get a procedural tiered Khmer roof. See "Landmarks" below. |
| Street lamps | none mapped in OSM here | **Generated**: 748 lamps, every 24–36 m along trunk, primary, secondary and tertiary roads and pedestrian streets, alternating sides, never inside buildings or water (`k: "lamp_gen"` in chunk payloads). |
| Street-name signs | real intersections | **Placed from data**: 181 signs where two differently named streets share an OSM node. Each has one blade per street, aligned with it, showing the OSM Khmer and English names. Posts stand 1.6 m beyond the wider carriageway, never inside buildings. |
| Tree species | 202 mapped tree positions | **Generated**: species (rain tree, ornamental, sugar palm), size and rotation are chosen deterministically per position. |
| Night lighting | | **Decorative**: which windows are lit says nothing about real occupancy. |

### Terrain: Wat Phnom

Phnom Penh is flat (about 10 m above sea level) apart from Wat Phnom, the man-made hill the
city is named after. It is modelled as a smooth mound: **27 m high** (the commonly published
figure), with a flat top 24 m in radius that holds the vihara and stupa, falling to street level
68 m from the centre (11.57613 N, 104.92322 E). The radii were fitted to the OSM positions of
the stupa, the vihara and the three mapped staircases. The shape is an approximation, not a
survey. The same function runs in Python (`app/geography/terrain.py`) and TypeScript
(`terrain.ts`), and shared fixtures test that they agree. The server publishes it in
`/world/config` → `terrain`.

### Landmarks (`LANDMARK_OVERRIDES` in `app/geography/regions.py`)

| OSM feature | Treatment | Height | Source |
|---|---|---|---|
| way 859466535: Phsar Thmei wings (X plan) | extruded | 10 m | **estimated** from photographs |
| way 859469220: Phsar Thmei central hall | Blender dome model (ribbed, louvred drum, lantern) on the wings | 26 m summit | **reference**: commonly published dome height |
| way 1034727803 | hidden | | duplicate of 859466535 (Hausdorff distance 0.3 m) |
| way 842087292 | hidden | | centre piece inside the dome model |
| way 269798573: Wat Phnom vihara | walls + tiered Khmer roof | 6 m walls | **estimated** |
| way 487758678: Wat Phnom stupa (`man_made=tower`, `tower:type=stupa`) | Blender chedi model | 18 m | **estimated** (about 2× its mapped base diameter) |

Buildings tagged `temple`, `pagoda`, `religious`, `monastery` or `shrine` (≥ 60 m²) also get a
Khmer roof and never get shopfronts.

**Known gaps:** OSM building coverage in Daun Penh is good but not complete. Some footprints
are approximate or outdated, and many buildings have no height, name or address. POI names
may be stale. The virtual city is **not** a live or exact replica of Phnom Penh.

## Coordinate system

UTM zone 48N (EPSG:32648), relative to the world origin at Phsar Thmei
(11.56955 N, 104.92115 E): `x = east`, `y = up`, `z = −north`, in metres. pyproj (backend) and
proj4 (frontend) use the same definition. A frontend unit test checks them against each other
to within 1 cm. UTM scale error over the neighbourhood is below 0.1 %, which a test also verifies.

## Refreshing the data

```bash
python3 tools/gis/fetch_osm.py                 # all snapshots (be polite: public Overpass)
cd backend && uv run python scripts/import_osm.py
```

Re-imports upsert rows on `(osm_type, osm_id)`, so database ids stay stable for features that
still exist. Features removed from OSM are deleted. Spawn points are recomputed and keep their
ids, so users' choices survive.

> Lesson recorded in a regression test: Overpass's global `[bbox:…]` setting returns `null`
> coordinates for nodes outside the box. Joining the remaining nodes turned the city side of
> the Tonle Sap into "water". The fetcher now filters per statement, and the parser refuses to
> build polygons from partial geometry.
