"""wardrobe garments: button shirts, jeans, a shoe style

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-23 19:20:00

Additive only: the style checks accept the new garments and avatars get a shoe style (existing
rows: sneakers, what they wear now). No existing value changes. An avatar's `model` stays
"avatar" (the original outfit, whatever its old style fields say) until the player saves new
clothes in the wardrobe, which stores "outfit".
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "avatar_customizations"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_avatar_customizations_top_style"), TABLE, type_="check")
    op.create_check_constraint(
        op.f("ck_avatar_customizations_top_style"), TABLE, "top_style IN ('hoodie','tee','shirt')"
    )
    op.drop_constraint(op.f("ck_avatar_customizations_bottom_style"), TABLE, type_="check")
    op.create_check_constraint(
        op.f("ck_avatar_customizations_bottom_style"),
        TABLE,
        "bottom_style IN ('trousers','jeans','shorts')",
    )
    op.add_column(
        TABLE,
        sa.Column("shoe_style", sa.String(length=10), nullable=False, server_default="sneakers"),
    )
    op.create_check_constraint(
        op.f("ck_avatar_customizations_shoe_style"), TABLE, "shoe_style IN ('sneakers','sandals')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_avatar_customizations_shoe_style"), TABLE, type_="check")
    op.drop_column(TABLE, "shoe_style")
    op.execute(
        "UPDATE avatar_customizations SET bottom_style = 'trousers' WHERE bottom_style = 'jeans'"
    )
    op.execute("UPDATE avatar_customizations SET top_style = 'tee' WHERE top_style = 'shirt'")
    op.drop_constraint(op.f("ck_avatar_customizations_bottom_style"), TABLE, type_="check")
    op.create_check_constraint(
        op.f("ck_avatar_customizations_bottom_style"),
        TABLE,
        "bottom_style IN ('trousers','shorts')",
    )
    op.drop_constraint(op.f("ck_avatar_customizations_top_style"), TABLE, type_="check")
    op.create_check_constraint(
        op.f("ck_avatar_customizations_top_style"), TABLE, "top_style IN ('hoodie','tee')"
    )
