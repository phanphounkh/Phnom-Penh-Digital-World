"""Synchronize region membership without stealing/deleting shared geographic features.

Caller owns the transaction and serializes imports. `region_id` remains the primary
gameplay owner for existing consumers. Other datasets cannot overwrite its geometry.
This is a prerequisite for shared chunks, not a cross-region import implementation.
"""

from typing import Any

from sqlalchemy import delete, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.geo import FEATURE_REGION_TABLES

BATCH = 400


async def sync_features(
    session: AsyncSession, model: Any, region_id: Any, rows: list[dict[str, Any]]
) -> int:
    """Upsert this dataset, replace its memberships, prune only unclaimed features.

    A primary owner that stops supplying a feature hands ownership to a remaining
    member without changing the feature ID. Its last canonical attributes survive
    until that member is refreshed; no source geometry is unioned or invented here.
    """
    if any(row.get("region_id") != region_id for row in rows):
        raise ValueError("Feature rows must belong to the region being synchronized")
    membership = FEATURE_REGION_TABLES[model.__tablename__]
    unique = {(row["osm_type"], row["osm_id"]): row for row in rows}
    values = list(unique.values())
    old_ids = set(
        await session.scalars(
            select(membership.c.feature_id).where(membership.c.region_id == region_id)
        )
    )
    current_ids: set[int] = set()
    for start in range(0, len(values), BATCH):
        batch = values[start : start + BATCH]
        stmt = insert(model).values(batch)
        fields = {
            k: stmt.excluded[k] for k in batch[0] if k not in {"osm_type", "osm_id", "region_id"}
        }
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["osm_type", "osm_id"],
                set_=fields,
                where=model.region_id == region_id,
            )
        )
        ids = list(
            await session.scalars(
                select(model.id).where(
                    tuple_(model.osm_type, model.osm_id).in_(
                        [(row["osm_type"], row["osm_id"]) for row in batch]
                    )
                )
            )
        )
        current_ids.update(ids)
        await session.execute(
            insert(membership)
            .values([{"feature_id": fid, "region_id": region_id} for fid in ids])
            .on_conflict_do_nothing()
        )
    stale = sorted(old_ids - current_ids)
    removed = 0
    for start in range(0, len(stale), BATCH):
        batch_ids = stale[start : start + BATCH]
        await session.execute(
            delete(membership).where(
                membership.c.region_id == region_id, membership.c.feature_id.in_(batch_ids)
            )
        )
        remaining: dict[int, Any] = {}
        for fid, rid in await session.execute(
            select(membership.c.feature_id, membership.c.region_id)
            .where(membership.c.feature_id.in_(batch_ids))
            .order_by(membership.c.region_id)
        ):
            remaining.setdefault(fid, rid)
        for fid, owner in await session.execute(
            select(model.id, model.region_id).where(model.id.in_(batch_ids))
        ):
            if fid in remaining and owner == region_id:
                await session.execute(
                    update(model).where(model.id == fid).values(region_id=remaining[fid])
                )
        orphan_ids = [fid for fid in batch_ids if fid not in remaining]
        if orphan_ids:
            await session.execute(delete(model).where(model.id.in_(orphan_ids)))
            removed += len(orphan_ids)
    return removed
