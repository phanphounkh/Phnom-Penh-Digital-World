"""Readiness: the API reports ready once the database is at the newest migration."""

from pathlib import Path

import httpx
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.api.v1.router import SCHEMA_REVISION

BACKEND = Path(__file__).resolve().parents[1]


def test_readiness_expects_the_newest_migration():
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    assert ScriptDirectory.from_config(cfg).get_current_head() == SCHEMA_REVISION


async def test_ready_at_the_newest_migration(client: httpx.AsyncClient):
    r = await client.get("/health/ready")
    assert r.status_code == 200 and r.json() == {"status": "ready"}
