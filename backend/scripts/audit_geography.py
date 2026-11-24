"""Offline: .venv/bin/python scripts/audit_geography.py [region ...] [--output path]."""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.geography.coverage import audit_snapshots

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("regions", nargs="*")
parser.add_argument(
    "--data-dir", type=Path, default=Path(__file__).resolve().parents[2] / "tools/gis/data/osm"
)
parser.add_argument("--output", type=Path)
args = parser.parse_args()
report = audit_snapshots(args.data_dir, args.regions or None)
body = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
if args.output:
    args.output.write_text(body)
print(body, end="")
raise SystemExit(bool(report["errors"]))
