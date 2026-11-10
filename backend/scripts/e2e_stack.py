"""Run an isolated API for the browser end-to-end tests.

    uv run python scripts/e2e_stack.py          # used by frontend/playwright.config.ts

It uses its own database (`<POSTGRES_DB>_e2e`, created with PostGIS on first use), its own
media folder and port 8001, so test bots never appear in the development world on :8000.
Each start migrates the schema, imports the OSM snapshot if the database is empty, resets every
account and everything people created (claims, shops, products, orders...; the map stays; set
E2E_KEEP_DATA=1 to keep them), creates the E2E administrator, then serves the API.
Development only: it refuses APP_ENV=production, and only ever touches the `*_e2e` database.
"""

import os
import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
PORT = int(os.environ.get("E2E_API_PORT", "8001"))
ADMIN_USER = "e2eadmin"
ADMIN_PASSWORD = "e2e-admin-password"  # noqa: S105  (isolated local test database only)


def main() -> None:
    env = {**dotenv_values(REPO / ".env"), **os.environ}
    if env.get("APP_ENV") == "production":
        raise SystemExit("Refusing to run the E2E stack with APP_ENV=production")
    base = env["DATABASE_URL"]
    head, _, name = base.rpartition("/")
    e2e_name = name.split("?")[0].removesuffix("_test") + "_e2e"
    e2e_url = f"{head}/{e2e_name}"

    import psycopg

    admin_dsn = head.replace("postgresql+psycopg://", "postgresql://") + "/postgres"
    with psycopg.connect(admin_dsn, autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (e2e_name,)
        ).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{e2e_name}"')
            print(f"Created database {e2e_name}")
    with psycopg.connect(admin_dsn.rsplit("/", 1)[0] + f"/{e2e_name}", autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    run_env = {
        **os.environ,
        "APP_ENV": "development",
        "DATABASE_URL": e2e_url,
        "ALLOWED_ORIGINS": ",".join(
            f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5174, 4174)
        ),
        "TRUST_PROXY_HEADERS": "true",
        "EXPOSE_DEV_VERIFICATION_CODES": "true",
        "RATE_LIMIT_SCALE": "20",  # many sign-ups from one machine; never in production
        "MEDIA_ROOT": str(BACKEND / "var" / "e2e-media"),
        "SEED_ADMIN_USERNAME": ADMIN_USER,
        "SEED_ADMIN_EMAIL": "e2eadmin@ppw.local",
        "SEED_ADMIN_PASSWORD": ADMIN_PASSWORD,
    }
    python = sys.executable
    subprocess.run(
        [python, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, env=run_env, check=True
    )
    subprocess.run(
        [python, "scripts/import_osm.py", "--if-empty"], cwd=BACKEND, env=run_env, check=True
    )
    if not os.environ.get("E2E_KEEP_DATA"):
        assert e2e_name.endswith("_e2e")
        with psycopg.connect(admin_dsn.rsplit("/", 1)[0] + f"/{e2e_name}", autocommit=True) as conn:
            # Everything that references a user (merchants, claims, shops, products, carts,
            # orders, payments, chat, sessions...) goes with CASCADE; geography is untouched.
            conn.execute("TRUNCATE users, world_rooms RESTART IDENTITY CASCADE")
        print(f"Reset accounts and marketplace data in {e2e_name}")
    subprocess.run([python, "scripts/seed.py"], cwd=BACKEND, env=run_env, check=True)
    os.chdir(BACKEND)
    os.execve(
        python,
        [python, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        run_env,
    )


if __name__ == "__main__":
    main()
