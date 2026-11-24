"""Offline geography checks; run with backend/.venv/bin/python -m unittest discover
-s tools/gis/tests -v (no database, no downloads).
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "backend"))
from app.geography.coverage import audit_snapshots, region_cells, require_importable

DATA = ROOT / "tools/gis/data/osm"


class CoverageTests(unittest.TestCase):
    def test_committed_snapshot_has_measured_coverage_and_attribution(self):
        report = require_importable(DATA)
        self.assertEqual(report["errors"], [])
        region = report["regions"][0]
        self.assertEqual(region["chunk_cells"], 90)
        self.assertEqual(region["buildings"], 2376)
        self.assertEqual(region["roads"], 787)
        self.assertEqual(region["water_features"], 12)
        self.assertIn("OpenStreetMap", region["source"])
        self.assertGreater(report["downloaded_coverage_percent"], 0.4)
        self.assertLess(report["downloaded_coverage_percent"], 0.5)

    def fixture(self, directory, *, broken=False):
        # Synthetic geometries test validation only; they are never imported as city data.
        slug = "fixture"
        bbox = (11.565, 104.9165, 11.566, 104.9175)
        elements = [
            {
                "type": "way",
                "id": 1,
                "tags": {"highway": "footway"},
                "geometry": [
                    {"lat": 11.5651, "lon": 104.9166},
                    None if broken else {"lat": 11.5659, "lon": 104.9174},
                ],
            }
        ]
        timestamp = "2026-11-07T23:23:51Z"
        name = "neighborhood-fixture"
        (directory / f"{name}.json").write_text(
            json.dumps({"elements": elements, "osm3s": {"timestamp_osm_base": timestamp}})
        )
        meta = {
            "bbox": list(bbox),
            "elements": 1,
            "osm_base_timestamp": timestamp,
            "source": "synthetic test fixture",
            "licence": "test only",
        }
        (directory / "manifest.json").write_text(json.dumps({name: meta}))
        return {slug: {"bbox": bbox}}, name

    def test_truncated_water_or_road_geometry_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            regions, _ = self.fixture(p, broken=True)
            report = audit_snapshots(p, regions=regions)
            self.assertTrue(any("incomplete/invalid geometry" in e for e in report["errors"]))
            self.assertEqual(report["regions"], [])

    def test_provenance_bbox_count_and_timestamp_must_match(self):
        for field, value in (
            ("bbox", [0, 0, 1, 1]),
            ("elements", 20),
            ("osm_base_timestamp", "stale"),
            ("licence", ""),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                regions, name = self.fixture(p)
                manifest = json.loads((p / "manifest.json").read_text())
                manifest[name][field] = value
                (p / "manifest.json").write_text(json.dumps(manifest))
                self.assertTrue(audit_snapshots(p, regions=regions)["errors"])

    def test_adjacent_degree_boxes_can_share_global_utm_cells(self):
        west = (11.565, 104.9165, 11.566, 104.9175)
        east = (11.565, 104.9175, 11.566, 104.9185)
        self.assertTrue(region_cells(west) & region_cells(east))
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            regions, _ = self.fixture(p)
            regions["next"] = {"bbox": east}
            report = audit_snapshots(p, ["fixture"], regions=regions)
            self.assertTrue(any("merge ownership" in e for e in report["errors"]))

    def test_unknown_region_and_missing_snapshot_fail_closed(self):
        self.assertTrue(audit_snapshots(DATA, ["unknown"])["errors"])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                require_importable(Path(tmp))

    def test_duplicate_ids_and_overpass_error_are_rejected(self):
        for kind in ("duplicate", "overpass"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp)
                regions, name = self.fixture(p)
                path = p / f"{name}.json"
                data = json.loads(path.read_text())
                if kind == "duplicate":
                    data["elements"] *= 2
                else:
                    data["remark"] = "runtime error: Query timed out"
                path.write_text(json.dumps(data))
                self.assertTrue(audit_snapshots(p, regions=regions)["errors"])

    def test_preflight_runs_before_any_city_import(self):
        # Import here so ordinary offline coverage use never loads DB configuration.
        from app.geography.importer import import_all

        city = AsyncMock()
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("app.geography.importer.import_city", city),
        ):
            with self.assertRaises(ValueError):
                asyncio.run(import_all(None, Path(tmp)))
        city.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
