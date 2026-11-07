"""Import the committed OSM snapshots into PostGIS and rebuild world chunks.

    uv run python scripts/import_osm.py                       # every configured neighbourhood
    uv run python scripts/import_osm.py daun-penh-central     # one neighbourhood
    uv run python scripts/import_osm.py --if-empty            # only when no chunks exist (Docker)

Refresh the snapshots first with:  python3 tools/gis/fetch_osm.py
"""

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.geography.importer import import_all
from app.models import WorldChunk


async def main(args: list[str]) -> None:
    started = time.perf_counter()
    if_empty = "--if-empty" in args
    slugs = [a for a in args if not a.startswith("--")]
    async with SessionLocal() as session:
        if if_empty and await session.scalar(select(func.count()).select_from(WorldChunk)):
            print("World chunks already present; skipping import (--if-empty).")
            await engine.dispose()
            return
        result = await import_all(session, settings.osm_data_dir, slugs or None)
    await engine.dispose()
    print(json.dumps(result, indent=2))
    print(f"Imported in {time.perf_counter() - started:.1f}s from {settings.osm_data_dir}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main(sys.argv[1:]))
