"""Keep geographic dataset membership separate from primary gameplay region.

Existing features and primary keys remain untouched; backfill their current membership.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FEATURES = ("roads", "buildings", "land_areas", "landmarks", "street_features")


def upgrade() -> None:
    for name in FEATURES:
        table = op.create_table(
            f"{name}_regions",
            sa.Column(
                "feature_id",
                sa.BigInteger(),
                sa.ForeignKey(f"{name}.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "region_id",
                sa.Uuid(),
                sa.ForeignKey("geographic_regions.id", ondelete="CASCADE"),
                primary_key=True,
            ),
        )
        op.create_index(f"ix_{name}_regions_region", table.name, ["region_id"])
        source = sa.table(name, sa.column("id"), sa.column("region_id"))
        op.execute(
            table.insert().from_select(
                ["feature_id", "region_id"], sa.select(source.c.id, source.c.region_id)
            )
        )


def downgrade() -> None:
    for name in reversed(FEATURES):
        op.drop_table(f"{name}_regions")
