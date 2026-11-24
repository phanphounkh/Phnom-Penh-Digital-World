"""Synthetic fixtures exercise dataset sharing, not new real geographic coverage."""

import importlib.util
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from shapely.geometry import LineString, MultiPolygon, Point, box
from sqlalchemy import func, select

from app.core.database import SessionLocal
from app.geography.importer import ewkt, import_all
from app.geography.ownership import sync_features
from app.models import Building, GeographicRegion, LandArea, Landmark, Road, StreetFeature
from app.models.geo import FEATURE_REGION_TABLES

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "migrations/versions/20261124_0007_geographic_membership.py"
)


async def regions(session):
    out = []
    for suffix in ("a", "b"):
        region = GeographicRegion(
            slug=f"fixture-{uuid.uuid4().hex[:12]}-{suffix}",
            name="Synthetic ownership fixture",
            kind="neighborhood",
            is_playable=False,
            is_service_area=False,
            boundary=ewkt(MultiPolygon([box(104, 11, 104.01, 11.01)])),
            dataset={},
        )
        session.add(region)
        out.append(region)
    await session.flush()
    return out


def feature_row(model, region_id, osm_id):
    row = {"region_id": region_id, "osm_type": "way", "osm_id": osm_id}
    if model is not StreetFeature:
        row.update(name="Original fixture", name_en=None, name_km=None)
    if model is Road:
        row.update(
            highway="footway",
            width_m=2.0,
            width_source="estimated",
            geom=ewkt(LineString([(104, 11), (104.001, 11.001)])),
        )
    elif model is Building:
        row.update(
            building="yes",
            height_m=6.0,
            height_source="estimated",
            footprint=ewkt(MultiPolygon([box(104, 11, 104.001, 11.001)])),
        )
    elif model is LandArea:
        row.update(kind="park", geom=ewkt(MultiPolygon([box(104, 11, 104.001, 11.001)])))
    elif model is Landmark:
        row.update(category="tourism", subtype="attraction", location=ewkt(Point(104, 11)))
    else:
        row.update(kind="tree", location=ewkt(Point(104, 11)))
    return row


@pytest.mark.parametrize("model", [Road, Building, LandArea, Landmark, StreetFeature])
async def test_shared_feature_keeps_id_and_survives_one_region_refresh(model):
    async with SessionLocal() as session:
        first, second = await regions(session)
        osm_id = 9_000_000_000 + uuid.uuid4().int % 1_000_000_000
        row = feature_row(model, first.id, osm_id)
        assert await sync_features(session, model, first.id, [row]) == 0
        feature = (await session.execute(select(model).where(model.osm_id == osm_id))).scalar_one()
        feature_id = feature.id
        second_row = {**row, "region_id": second.id}
        if model is not StreetFeature:
            second_row["name"] = "Other dataset must not replace canonical attributes"
        assert await sync_features(session, model, second.id, [second_row]) == 0
        await session.refresh(feature)
        assert feature.id == feature_id and feature.region_id == first.id
        if model is not StreetFeature:
            assert feature.name == "Original fixture"
        membership = FEATURE_REGION_TABLES[model.__tablename__]
        assert (
            await session.scalar(
                select(func.count())
                .select_from(membership)
                .where(membership.c.feature_id == feature_id)
            )
            == 2
        )
        # Reimporting the same data is idempotent.
        await sync_features(session, model, second.id, [second_row])
        assert (
            await session.scalar(
                select(func.count())
                .select_from(membership)
                .where(membership.c.feature_id == feature_id)
            )
            == 2
        )
        # Removing a secondary source must leave the primary source untouched.
        assert await sync_features(session, model, second.id, []) == 0
        await session.refresh(feature)
        assert feature.region_id == first.id
        await sync_features(session, model, second.id, [second_row])
        assert await sync_features(session, model, first.id, []) == 0
        await session.refresh(feature)
        assert feature.id == feature_id and feature.region_id == second.id
        # The new primary owner can refresh attributes on its next import.
        await sync_features(session, model, second.id, [second_row])
        await session.refresh(feature)
        if model is not StreetFeature:
            assert feature.name == second_row["name"]
        assert await sync_features(session, model, second.id, []) == 1
        assert (
            await session.scalar(
                select(func.count()).select_from(model).where(model.id == feature_id)
            )
            == 0
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(membership)
                .where(membership.c.feature_id == feature_id)
            )
            == 0
        )
        # Session close rolls back all synthetic data, preserving the real fixture.


async def test_real_import_populates_memberships_and_keeps_ids(imported_geography):
    async with SessionLocal() as session:
        before = set((await session.execute(select(Building.id))).scalars())
        from app.core.config import settings

        await import_all(session, settings.osm_data_dir, ["daun-penh-central"])
        after = set((await session.execute(select(Building.id))).scalars())
        membership = FEATURE_REGION_TABLES["buildings"]
        linked = set(await session.scalars(select(membership.c.feature_id)))
        assert before == after == linked


async def test_migration_backfills_existing_features_without_changing_ids():
    spec = importlib.util.spec_from_file_location("membership_migration", MIGRATION_PATH)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    async with SessionLocal() as session:
        models = [Road, Building, LandArea, Landmark, StreetFeature]
        before = {
            m.__tablename__: set(await session.execute(select(m.id, m.region_id))) for m in models
        }
        conn = await session.connection()

        def migrate(connection):
            operations = Operations(MigrationContext.configure(connection))
            with patch.object(migration, "op", operations):
                migration.downgrade()
                migration.upgrade()

        # PostgreSQL DDL is transactional; closing the session restores the original schema.
        await conn.run_sync(migrate)
        for model in models:
            membership = FEATURE_REGION_TABLES[model.__tablename__]
            assert (
                set(await session.execute(select(model.id, model.region_id)))
                == before[model.__tablename__]
            )
            assert (
                set(await session.execute(select(membership.c.feature_id, membership.c.region_id)))
                == before[model.__tablename__]
            )
