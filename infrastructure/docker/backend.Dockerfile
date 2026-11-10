# Phnom Penh Digital World API (FastAPI + PostGIS). Build context: repository root.
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv
WORKDIR /app/backend

COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/ ./
# The committed OSM snapshots, imported on first start.
COPY tools/gis/data/osm /app/tools/gis/data/osm

RUN useradd --system --uid 10001 ppw && mkdir -p /app/var/media && chown -R ppw /app
USER ppw
ENV PATH="/app/backend/.venv/bin:$PATH" OSM_DATA_DIR=/app/tools/gis/data/osm
EXPOSE 8000
# Migrate, import the map once (idempotent, skipped when chunks exist), then serve.
CMD ["sh", "-c", "alembic upgrade head && python scripts/import_osm.py --if-empty && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
