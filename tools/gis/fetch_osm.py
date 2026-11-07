#!/usr/bin/env python3
"""Download OpenStreetMap snapshots for Phnom Penh Digital World from the Overpass API.

Writes raw Overpass JSON to tools/gis/data/osm/ plus a manifest.json describing each
snapshot (query, bounding box, OSM data timestamp, licence). The snapshots are committed so
the world can be rebuilt reproducibly and offline; re-run this script to refresh them.

Data © OpenStreetMap contributors, available under the Open Database Licence (ODbL 1.0).

Usage:
    python3 tools/gis/fetch_osm.py                # all datasets
    python3 tools/gis/fetch_osm.py neighborhood   # one dataset
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

# Region definitions live in the backend so the importer and this script never disagree.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.geography.regions import NEIGHBORHOODS  # noqa: E402

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "phnom-penh-digital-world-dev/0.1 (OSM snapshot importer)"
OUT_DIR = Path(__file__).resolve().parent / "data" / "osm"


def neighborhood_query(s: float, w: float, n: float, e: float) -> str:
    # The bbox is applied per statement, NOT as a global [bbox:] setting: with a global bbox,
    # `out geom` returns null coordinates for nodes outside it, which corrupts large polygons
    # such as the Tonle Sap river. The importer clips everything to the region instead.
    bb = f"({s},{w},{n},{e})"
    return f"""
[out:json][timeout:180];
(
  way["highway"]{bb};
  way["building"]{bb};
  relation["building"]["type"="multipolygon"]{bb};
  way["leisure"]{bb};
  way["landuse"~"^(grass|village_green|recreation_ground|religious)$"]{bb};
  way["natural"]{bb};
  relation["natural"="water"]{bb};
  relation["leisure"]{bb};
  relation["landuse"~"^(grass|village_green|recreation_ground|religious)$"]{bb};
  way["waterway"]{bb};
  way["amenity"]{bb};
  way["tourism"]{bb};
  way["historic"]{bb};
  way["man_made"]{bb};
  node["amenity"]{bb};
  node["shop"]{bb};
  node["tourism"]{bb};
  node["historic"]{bb};
  node["office"]{bb};
  node["natural"="tree"]{bb};
  node["highway"~"traffic_signals|street_lamp|crossing"]{bb};
  node["place"]{bb};
);
out geom;
"""


CITY_QUERY = """
[out:json][timeout:240];
area["boundary"="administrative"]["admin_level"="4"]["name:en"="Phnom Penh"]->.pp;
(
  node["place"~"^(suburb|quarter|neighbourhood|village|town|city)$"](area.pp);
  relation["boundary"="administrative"]["admin_level"~"^(6|7|8)$"](area.pp);
  node["amenity"="marketplace"](area.pp);
  way["amenity"="marketplace"](area.pp);
  node["tourism"~"^(attraction|museum|viewpoint)$"](area.pp);
  way["tourism"~"^(attraction|museum)$"](area.pp);
  way["amenity"~"^(university|hospital)$"]["name"](area.pp);
);
out center tags;
"""

BOUNDARY_QUERY = """
[out:json][timeout:240];
relation["boundary"="administrative"]["admin_level"="4"]["name:en"="Phnom Penh"];
out geom;
"""


def run(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    last_error: Exception | None = None
    for attempt in range(3):
        for url in OVERPASS_URLS:
            request = urllib.request.Request(
                url, data=body, headers={"User-Agent": USER_AGENT}, method="POST"
            )
            try:
                with urllib.request.urlopen(request, timeout=300) as response:  # noqa: S310
                    return json.loads(response.read())
            except Exception as exc:  # network errors, 429/504 from busy servers
                last_error = exc
                print(f"  {url} failed ({exc}); trying again", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass request failed: {last_error}")


def datasets() -> dict[str, tuple[str, dict]]:
    out: dict[str, tuple[str, dict]] = {}
    for slug, hood in NEIGHBORHOODS.items():
        s, w, n, e = hood["bbox"]
        out[f"neighborhood-{slug}"] = (
            neighborhood_query(s, w, n, e),
            {"kind": "neighborhood", "region": slug, "bbox": [s, w, n, e]},
        )
    out["city-places"] = (CITY_QUERY, {"kind": "city-places", "region": "phnom-penh"})
    out["city-boundary"] = (BOUNDARY_QUERY, {"kind": "city-boundary", "region": "phnom-penh"})
    return out


def main(selected: list[str]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, (query, meta) in datasets().items():
        if selected and not any(name.endswith(s) or name == s for s in selected):
            continue
        print(f"Fetching {name} …")
        data = run(query)
        elements = data.get("elements", [])
        (OUT_DIR / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False))
        manifest[name] = {
            **meta,
            "file": f"{name}.json",
            "elements": len(elements),
            "osm_base_timestamp": data.get("osm3s", {}).get("timestamp_osm_base"),
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "source": "OpenStreetMap via Overpass API",
            "licence": "ODbL 1.0 — © OpenStreetMap contributors",
            "query": query.strip(),
        }
        print(f"  {len(elements)} elements, OSM base {manifest[name]['osm_base_timestamp']}")
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
        time.sleep(3)  # be polite to the shared Overpass service


if __name__ == "__main__":
    main(sys.argv[1:])
