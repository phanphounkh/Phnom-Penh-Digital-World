# GIS tools

`fetch_osm.py` downloads OpenStreetMap snapshots from the public Overpass API into `data/osm/`
(committed, so the world can be rebuilt offline) and records them in `manifest.json`. It uses
only the standard library.

```bash
python3 tools/gis/fetch_osm.py                     # all datasets
python3 tools/gis/fetch_osm.py daun-penh-central   # one neighbourhood
cd backend && uv run python scripts/import_osm.py   # load into PostGIS and rebuild chunks
```

Regions and spawn landmarks are defined once, in `backend/app/geography/regions.py`, and this
script imports them from there. To add a neighbourhood, add a bbox to `NEIGHBORHOODS`, then
fetch and import.

Please respect the [Overpass usage policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html):
fetch rarely, and keep the snapshots committed. Data © OpenStreetMap contributors, ODbL 1.0.
Accuracy notes are in `docs/DATA.md`.
