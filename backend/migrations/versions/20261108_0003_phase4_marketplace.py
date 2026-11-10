"""Phase 4: marketplace (virtual shop units and claims, transfers, disputes, merchants and
verification documents, shops, product categories, products, inventory, carts, the demo
checkout's payment intents, orders with history, and simulated refunds).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-08 10:34:10.877367

"""

from collections.abc import Sequence

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


CATEGORIES = [
    # id, slug, name, name_km, policy, policy_note, min_age
    (1, "food", "Prepared food", "អាហារ", "allowed", None, None),
    (2, "drinks", "Drinks (non-alcoholic)", "ភេសជ្ជៈ", "allowed", None, None),
    (3, "groceries", "Groceries", "គ្រឿងឧបភោគបរិភោគ", "allowed", None, None),
    (4, "fashion", "Clothing & accessories", "សម្លៀកបំពាក់", "allowed", None, None),
    (5, "electronics", "Electronics", "គ្រឿងអេឡិចត្រូនិច", "allowed", None, None),
    (6, "crafts", "Crafts & souvenirs", "សិប្បកម្ម", "allowed", None, None),
    (7, "books", "Books & stationery", "សៀវភៅ", "allowed", None, None),
    (8, "beauty", "Beauty & personal care", "គ្រឿងសំអាង", "allowed", None, None),
    (9, "home", "Home & kitchen", "គ្រឿងប្រើប្រាស់ក្នុងផ្ទះ", "allowed", None, None),
    (10, "toys", "Toys & games", "ប្រដាប់ក្មេងលេង", "allowed", None, None),
    (
        20,
        "alcohol",
        "Alcoholic drinks",
        "គ្រឿងស្រវឹង",
        "restricted",
        "Every listing is reviewed by an administrator; buyers must confirm they are 18 or older.",
        18,
    ),
    (30, "tobacco", "Tobacco & e-cigarettes", "ថ្នាំជក់", "prohibited", "Not allowed.", None),
    (
        31,
        "medicine",
        "Medicines",
        "ឱសថ",
        "prohibited",
        "Not allowed: medicines need a licensed pharmacy.",
        None,
    ),
    (32, "weapons", "Weapons", "អាវុធ", "prohibited", "Not allowed.", None),
    (
        33,
        "other_regulated",
        "Other regulated goods",
        None,
        "prohibited",
        "Drugs, live animals, gambling and counterfeit goods are not allowed.",
        None,
    ),
]


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(sa.schema.CreateSequence(sa.Sequence("order_number_seq", start=100001)))
    op.create_table(
        "product_categories",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("slug", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("name_km", sa.String(length=60), nullable=True),
        sa.Column("policy", sa.String(length=16), nullable=False),
        sa.Column("policy_note", sa.String(length=200), nullable=True),
        sa.Column("min_age", sa.SmallInteger(), nullable=True),
        sa.Column("sort_order", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint(
            "policy IN ('allowed', 'restricted', 'prohibited')",
            name=op.f("ck_product_categories_policy_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_categories")),
        sa.UniqueConstraint("slug", name=op.f("uq_product_categories_slug")),
    )
    op.create_table(
        "carts",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_carts_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_carts")),
        sa.UniqueConstraint("user_id", name=op.f("uq_carts_user_id")),
    )
    categories = sa.table(
        "product_categories",
        sa.column("id", sa.SmallInteger),
        sa.column("slug", sa.String),
        sa.column("name", sa.String),
        sa.column("name_km", sa.String),
        sa.column("policy", sa.String),
        sa.column("policy_note", sa.String),
        sa.column("min_age", sa.SmallInteger),
        sa.column("sort_order", sa.SmallInteger),
    )
    op.bulk_insert(
        categories,
        [
            dict(
                zip(
                    ("id", "slug", "name", "name_km", "policy", "policy_note", "min_age"),
                    c,
                    strict=True,
                )
            )
            | {"sort_order": c[0]}
            for c in CATEGORIES
        ],
    )
    op.create_table(
        "merchants",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("business_name", sa.String(length=120), nullable=False),
        sa.Column("business_name_km", sa.String(length=120), nullable=True),
        sa.Column("category", sa.String(length=24), nullable=False),
        sa.Column("description", sa.String(length=600), nullable=True),
        sa.Column("contact_phone", sa.String(length=20), nullable=True),
        sa.Column("contact_email", sa.String(length=255), nullable=True),
        sa.Column("business_address", sa.String(length=300), nullable=True),
        sa.Column(
            "operating_hours",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("decided_by_id", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.String(length=300), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "category IN ('food_drink', 'grocery', 'fashion', 'electronics', 'crafts', 'books', 'beauty', 'home', 'services', 'other')",
            name=op.f("ck_merchants_category_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'suspended')",
            name=op.f("ck_merchants_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_id"],
            ["users.id"],
            name=op.f("fk_merchants_decided_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name=op.f("fk_merchants_owner_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_merchants")),
        sa.UniqueConstraint("owner_id", name=op.f("uq_merchants_owner_id")),
    )
    op.create_index("ix_merchants_status", "merchants", ["status"], unique=False)
    op.create_table(
        "payment_intents",
        sa.Column("buyer_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("amount_minor", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("provider", sa.String(length=16), server_default="demo", nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("reference", sa.String(length=40), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("succeeded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("currency = 'USD'", name=op.f("ck_payment_intents_currency_usd")),
        sa.CheckConstraint("provider = 'demo'", name=op.f("ck_payment_intents_provider_demo")),
        sa.CheckConstraint(
            "status IN ('requires_confirmation', 'succeeded', 'cancelled', 'expired')",
            name=op.f("ck_payment_intents_status_valid"),
        ),
        sa.CheckConstraint("amount_minor > 0", name=op.f("ck_payment_intents_amount_positive")),
        sa.ForeignKeyConstraint(
            ["buyer_id"],
            ["users.id"],
            name=op.f("fk_payment_intents_buyer_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payment_intents")),
        sa.UniqueConstraint("buyer_id", "idempotency_key", name="uq_payment_intents_idempotency"),
        sa.UniqueConstraint("reference", name=op.f("uq_payment_intents_reference")),
    )
    op.create_index(
        "ix_payment_intents_status_expires",
        "payment_intents",
        ["status", "expires_at"],
        unique=False,
    )
    op.create_table(
        "merchant_verifications",
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("original_name", sa.String(length=160), nullable=False),
        sa.Column("stored_name", sa.String(length=64), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="submitted", nullable=False),
        sa.Column("reviewed_by_id", sa.Uuid(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('business_registration', 'id_document', 'lease_or_utility', 'other')",
            name=op.f("ck_merchant_verifications_kind_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('submitted','accepted','rejected')",
            name=op.f("ck_merchant_verifications_status_valid"),
        ),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_merchant_verifications_size_positive")),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_merchant_verifications_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by_id"],
            ["users.id"],
            name=op.f("fk_merchant_verifications_reviewed_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_merchant_verifications")),
        sa.UniqueConstraint("stored_name", name=op.f("uq_merchant_verifications_stored_name")),
    )
    op.create_index(
        op.f("ix_merchant_verifications_merchant_id"),
        "merchant_verifications",
        ["merchant_id"],
        unique=False,
    )
    op.create_table(
        "products",
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.SmallInteger(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("name_km", sa.String(length=80), nullable=True),
        sa.Column("description", sa.String(length=1000), nullable=True),
        sa.Column("price_minor", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("image_name", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=16), server_default="box", nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("review_note", sa.String(length=300), nullable=True),
        sa.Column(
            "fulfillment", sa.ARRAY(sa.String(length=16)), server_default="{pickup}", nullable=False
        ),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("currency = 'USD'", name=op.f("ck_products_currency_usd")),
        sa.CheckConstraint(
            "fulfillment <@ ARRAY['pickup','delivery']::varchar[] AND cardinality(fulfillment) >= 1",
            name=op.f("ck_products_fulfillment_valid"),
        ),
        sa.CheckConstraint(
            "model IN ('box', 'bag', 'bottle', 'book', 'jar', 'shirt', 'phone', 'basket', 'burger', 'cake', 'coffee', 'drink', 'fries', 'noodles', 'pizza', 'rice')",
            name=op.f("ck_products_model_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('active', 'hidden', 'pending_review', 'rejected', 'archived')",
            name=op.f("ck_products_status_valid"),
        ),
        sa.CheckConstraint(
            "price_minor > 0 AND price_minor <= 1000000", name=op.f("ck_products_price_range")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["product_categories.id"],
            name=op.f("fk_products_category_id_product_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_products_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_products")),
    )
    op.create_index(
        "ix_products_merchant_status", "products", ["merchant_id", "status"], unique=False
    )
    op.create_table(
        "virtual_properties",
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("unit_key", sa.String(length=64), nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("building_id", sa.BigInteger(), nullable=True),
        sa.Column("kind", sa.String(length=16), server_default="shop_unit", nullable=False),
        sa.Column("street_name", sa.String(length=200), nullable=True),
        sa.Column("street_name_km", sa.String(length=200), nullable=True),
        sa.Column("door_x", sa.Float(), nullable=False),
        sa.Column("door_z", sa.Float(), nullable=False),
        sa.Column("heading", sa.Float(), nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("depth_m", sa.Float(), nullable=False),
        sa.Column("ceiling_m", sa.Float(), nullable=False),
        sa.Column("corners", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "footprint",
            geoalchemy2.Geometry(
                geometry_type="POLYGON",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "door",
            geoalchemy2.Geometry(
                geometry_type="POINT",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("requires_verification", sa.Boolean(), nullable=False),
        sa.Column("real_business_name", sa.String(length=200), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind = 'shop_unit'", name=op.f("ck_virtual_properties_kind_valid")),
        sa.CheckConstraint(
            "width_m > 0 AND depth_m > 0 AND ceiling_m > 0",
            name=op.f("ck_virtual_properties_size_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_virtual_properties_building_id_buildings"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_virtual_properties_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_virtual_properties")),
        sa.UniqueConstraint("code", name=op.f("uq_virtual_properties_code")),
        sa.UniqueConstraint("unit_key", name=op.f("uq_virtual_properties_unit_key")),
    )
    op.create_index(
        "ix_virtual_properties_building", "virtual_properties", ["building_id"], unique=False
    )
    op.create_index(
        "ix_virtual_properties_door",
        "virtual_properties",
        ["door"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_index(
        "ix_virtual_properties_footprint",
        "virtual_properties",
        ["footprint"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_table(
        "inventory",
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("on_hand", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "on_hand >= 0 AND on_hand <= 100000", name=op.f("ck_inventory_on_hand_range")
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_inventory_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("product_id", name=op.f("pk_inventory")),
    )
    op.create_table(
        "property_claims",
        sa.Column("property_id", sa.Uuid(), nullable=False),
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("evidence_note", sa.String(length=600), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("decided_by_id", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.String(length=300), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'released', 'expired', 'revoked', 'transferred')",
            name=op.f("ck_property_claims_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_id"],
            ["users.id"],
            name=op.f("fk_property_claims_decided_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["merchant_verifications.id"],
            name=op.f("fk_property_claims_document_id_merchant_verifications"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_property_claims_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["property_id"],
            ["virtual_properties.id"],
            name=op.f("fk_property_claims_property_id_virtual_properties"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_property_claims")),
    )
    op.create_index(
        "ix_property_claims_merchant_status",
        "property_claims",
        ["merchant_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_property_claims_status_expires",
        "property_claims",
        ["status", "expires_at"],
        unique=False,
    )
    op.create_index(
        "uq_property_claims_live",
        "property_claims",
        ["property_id"],
        unique=True,
        postgresql_where="status IN ('pending','approved')",
    )
    op.create_table(
        "property_disputes",
        sa.Column("property_id", sa.Uuid(), nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("disputer_id", sa.Uuid(), nullable=False),
        sa.Column("reason", sa.String(length=1000), nullable=False),
        sa.Column("contact", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="open", nullable=False),
        sa.Column("resolution_note", sa.String(length=300), nullable=True),
        sa.Column("decided_by_id", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('open','upheld','rejected')", name=op.f("ck_property_disputes_status_valid")
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"],
            ["property_claims.id"],
            name=op.f("fk_property_disputes_claim_id_property_claims"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_id"],
            ["users.id"],
            name=op.f("fk_property_disputes_decided_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["disputer_id"],
            ["users.id"],
            name=op.f("fk_property_disputes_disputer_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["property_id"],
            ["virtual_properties.id"],
            name=op.f("fk_property_disputes_property_id_virtual_properties"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_property_disputes")),
    )
    op.create_index("ix_property_disputes_status", "property_disputes", ["status"], unique=False)
    op.create_table(
        "property_transfers",
        sa.Column("claim_id", sa.Uuid(), nullable=False),
        sa.Column("from_merchant_id", sa.Uuid(), nullable=False),
        sa.Column("to_merchant_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending','accepted','declined','cancelled')",
            name=op.f("ck_property_transfers_status_valid"),
        ),
        sa.CheckConstraint(
            "from_merchant_id <> to_merchant_id", name=op.f("ck_property_transfers_not_self")
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"],
            ["property_claims.id"],
            name=op.f("fk_property_transfers_claim_id_property_claims"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["from_merchant_id"],
            ["merchants.id"],
            name=op.f("fk_property_transfers_from_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["to_merchant_id"],
            ["merchants.id"],
            name=op.f("fk_property_transfers_to_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_property_transfers")),
    )
    op.create_index(
        op.f("ix_property_transfers_to_merchant_id"),
        "property_transfers",
        ["to_merchant_id"],
        unique=False,
    )
    op.create_index(
        "uq_property_transfers_pending",
        "property_transfers",
        ["claim_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_table(
        "shops",
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("property_id", sa.Uuid(), nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("name_km", sa.String(length=60), nullable=True),
        sa.Column("tagline", sa.String(length=80), nullable=True),
        sa.Column("theme", sa.String(length=16), server_default="market", nullable=False),
        sa.Column("primary_color", sa.String(length=7), nullable=False),
        sa.Column("accent_color", sa.String(length=7), nullable=False),
        sa.Column("is_open", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("status", sa.String(length=8), server_default="active", nullable=False),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "accent_color ~ '^#[0-9a-f]{6}$'", name=op.f("ck_shops_accent_color_hex")
        ),
        sa.CheckConstraint(
            "primary_color ~ '^#[0-9a-f]{6}$'", name=op.f("ck_shops_primary_color_hex")
        ),
        sa.CheckConstraint("status IN ('active','ended')", name=op.f("ck_shops_status_valid")),
        sa.CheckConstraint(
            "theme IN ('market', 'cafe', 'boutique', 'tech', 'books')",
            name=op.f("ck_shops_theme_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["claim_id"],
            ["property_claims.id"],
            name=op.f("fk_shops_claim_id_property_claims"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_shops_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["property_id"],
            ["virtual_properties.id"],
            name=op.f("fk_shops_property_id_virtual_properties"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_shops")),
        sa.UniqueConstraint("claim_id", name=op.f("uq_shops_claim_id")),
    )
    op.create_index("ix_shops_merchant", "shops", ["merchant_id"], unique=False)
    op.create_index(
        "uq_shops_property_active",
        "shops",
        ["property_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "cart_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("cart_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("shop_id", sa.Uuid(), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("quoted_price_minor", sa.Integer(), nullable=False),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint("quantity BETWEEN 1 AND 20", name=op.f("ck_cart_items_quantity_range")),
        sa.CheckConstraint("quoted_price_minor > 0", name=op.f("ck_cart_items_quoted_positive")),
        sa.ForeignKeyConstraint(
            ["cart_id"], ["carts.id"], name=op.f("fk_cart_items_cart_id_carts"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_cart_items_merchant_id_merchants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_cart_items_product_id_products"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["shop_id"], ["shops.id"], name=op.f("fk_cart_items_shop_id_shops"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_cart_items")),
        sa.UniqueConstraint("cart_id", "product_id", name="uq_cart_items_cart_product"),
    )
    op.create_table(
        "orders",
        sa.Column(
            "number",
            sa.String(length=20),
            server_default=sa.text("'PP-' || nextval('order_number_seq'::regclass)"),
            nullable=False,
        ),
        sa.Column("buyer_id", sa.Uuid(), nullable=True),
        sa.Column("merchant_id", sa.Uuid(), nullable=False),
        sa.Column("pickup_shop_id", sa.Uuid(), nullable=True),
        sa.Column("payment_intent_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("fulfillment", sa.String(length=16), nullable=False),
        sa.Column("subtotal_minor", sa.Integer(), nullable=False),
        sa.Column("delivery_fee_minor", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_minor", sa.Integer(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column("cancel_reason", sa.String(length=300), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("currency = 'USD'", name=op.f("ck_orders_currency_usd")),
        sa.CheckConstraint(
            "fulfillment IN ('pickup', 'delivery')", name=op.f("ck_orders_fulfillment_valid")
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'pending_payment', 'paid', 'merchant_accepted', 'preparing', 'ready_for_pickup', 'assigned_to_driver', 'picked_up', 'in_transit', 'delivered', 'completed', 'cancelled', 'refunded')",
            name=op.f("ck_orders_status_valid"),
        ),
        sa.CheckConstraint(
            "subtotal_minor >= 0 AND delivery_fee_minor >= 0 AND total_minor = subtotal_minor + delivery_fee_minor",
            name=op.f("ck_orders_totals_consistent"),
        ),
        sa.ForeignKeyConstraint(
            ["buyer_id"], ["users.id"], name=op.f("fk_orders_buyer_id_users"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["merchant_id"],
            ["merchants.id"],
            name=op.f("fk_orders_merchant_id_merchants"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["payment_intent_id"],
            ["payment_intents.id"],
            name=op.f("fk_orders_payment_intent_id_payment_intents"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["pickup_shop_id"],
            ["shops.id"],
            name=op.f("fk_orders_pickup_shop_id_shops"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
        sa.UniqueConstraint("number", name=op.f("uq_orders_number")),
    )
    op.create_index("ix_orders_buyer_created", "orders", ["buyer_id", "created_at"], unique=False)
    op.create_index("ix_orders_merchant_status", "orders", ["merchant_id", "status"], unique=False)
    op.create_index(
        op.f("ix_orders_payment_intent_id"), "orders", ["payment_intent_id"], unique=False
    )
    op.create_table(
        "order_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("from_status", sa.String(length=24), nullable=True),
        sa.Column("to_status", sa.String(length=24), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("actor_role", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_order_events_actor_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_events_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_events")),
    )
    op.create_index(op.f("ix_order_events_order_id"), "order_events", ["order_id"], unique=False)
    op.create_table(
        "order_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("name_km", sa.String(length=80), nullable=True),
        sa.Column("unit_price_minor", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("line_total_minor", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "line_total_minor = unit_price_minor * quantity", name=op.f("ck_order_items_line_total")
        ),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_order_items_quantity_positive")),
        sa.CheckConstraint("unit_price_minor > 0", name=op.f("ck_order_items_unit_price_positive")),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_order_items_order_id_orders"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["products.id"],
            name=op.f("fk_order_items_product_id_products"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_items")),
    )
    op.create_index(op.f("ix_order_items_order_id"), "order_items", ["order_id"], unique=False)
    op.create_table(
        "refunds",
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("payment_intent_id", sa.Uuid(), nullable=False),
        sa.Column("amount_minor", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=300), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("amount_minor > 0", name=op.f("ck_refunds_amount_positive")),
        sa.ForeignKeyConstraint(
            ["actor_id"], ["users.id"], name=op.f("fk_refunds_actor_id_users"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_refunds_order_id_orders"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["payment_intent_id"],
            ["payment_intents.id"],
            name=op.f("fk_refunds_payment_intent_id_payment_intents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refunds")),
        sa.UniqueConstraint("order_id", name=op.f("uq_refunds_order_id")),
    )
    op.create_index(
        op.f("ix_refunds_payment_intent_id"), "refunds", ["payment_intent_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f("ix_refunds_payment_intent_id"), table_name="refunds")
    op.drop_table("refunds")
    op.drop_index(op.f("ix_order_items_order_id"), table_name="order_items")
    op.drop_table("order_items")
    op.drop_index(op.f("ix_order_events_order_id"), table_name="order_events")
    op.drop_table("order_events")
    op.drop_index(op.f("ix_orders_payment_intent_id"), table_name="orders")
    op.drop_index("ix_orders_merchant_status", table_name="orders")
    op.drop_index("ix_orders_buyer_created", table_name="orders")
    op.drop_table("orders")
    op.drop_table("cart_items")
    op.drop_index(
        "uq_shops_property_active",
        table_name="shops",
        postgresql_where=sa.text("status = 'active'"),
    )
    op.drop_index("ix_shops_merchant", table_name="shops")
    op.drop_table("shops")
    op.drop_index(
        "uq_property_transfers_pending",
        table_name="property_transfers",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_index(op.f("ix_property_transfers_to_merchant_id"), table_name="property_transfers")
    op.drop_table("property_transfers")
    op.drop_index("ix_property_disputes_status", table_name="property_disputes")
    op.drop_table("property_disputes")
    op.drop_index(
        "uq_property_claims_live",
        table_name="property_claims",
        postgresql_where="status IN ('pending','approved')",
    )
    op.drop_index("ix_property_claims_status_expires", table_name="property_claims")
    op.drop_index("ix_property_claims_merchant_status", table_name="property_claims")
    op.drop_table("property_claims")
    op.drop_table("inventory")
    op.drop_index(
        "ix_virtual_properties_footprint", table_name="virtual_properties", postgresql_using="gist"
    )
    op.drop_index(
        "ix_virtual_properties_door", table_name="virtual_properties", postgresql_using="gist"
    )
    op.drop_index("ix_virtual_properties_building", table_name="virtual_properties")
    op.drop_table("virtual_properties")
    op.drop_index("ix_products_merchant_status", table_name="products")
    op.drop_table("products")
    op.drop_index(
        op.f("ix_merchant_verifications_merchant_id"), table_name="merchant_verifications"
    )
    op.drop_table("merchant_verifications")
    op.drop_index("ix_payment_intents_status_expires", table_name="payment_intents")
    op.drop_table("payment_intents")
    op.drop_index("ix_merchants_status", table_name="merchants")
    op.drop_table("merchants")
    op.drop_table("carts")
    op.drop_table("product_categories")
    op.execute(sa.schema.DropSequence(sa.Sequence("order_number_seq")))
