"""Phase 1: identity (users, roles, profiles, sessions, avatars, verification, private
addresses), geography (regions, OSM roads/buildings/areas/landmarks, chunks, spawn points)
and audit logging.

Revision ID: 0001
Revises:
Create Date: 2026-11-08 05:40:49.422057

"""

from collections.abc import Sequence

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # The test suite recreates the public schema, which drops extensions: always ensure them.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "geographic_regions",
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("name_km", sa.String(length=160), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("is_playable", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("is_service_area", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "boundary",
            geoalchemy2.Geometry(
                geometry_type="MULTIPOLYGON",
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
            "dataset", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
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
            "kind IN ('city','district','neighborhood')", name=op.f("ck_geographic_regions_kind")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geographic_regions")),
        sa.UniqueConstraint("slug", name=op.f("uq_geographic_regions_slug")),
    )
    op.create_index(
        "ix_geographic_regions_boundary",
        "geographic_regions",
        ["boundary"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_table(
        "places",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_en", sa.String(length=200), nullable=True),
        sa.Column("name_km", sa.String(length=200), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("search_text", sa.String(length=700), nullable=False),
        sa.Column(
            "location",
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_places")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_places_osm"),
    )
    op.create_index(
        "ix_places_location", "places", ["location"], unique=False, postgresql_using="gist"
    )
    op.create_index(
        "ix_places_search_trgm",
        "places",
        ["search_text"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    op.create_table(
        "users",
        sa.Column("username", sa.String(length=24), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=20), nullable=True),
        sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("phone_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("terms_version", sa.String(length=32), nullable=False),
        sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("privacy_accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True), nullable=True),
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
            "username ~ '^[a-z0-9_.]{3,24}$'", name=op.f("ck_users_username_format")
        ),
        sa.CheckConstraint(
            "email IS NOT NULL OR phone IS NOT NULL", name=op.f("ck_users_has_contact")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
        sa.UniqueConstraint("phone", name=op.f("uq_users_phone")),
        sa.UniqueConstraint("username", name=op.f("uq_users_username")),
    )
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=32), nullable=True),
        sa.Column("target_id", sa.String(length=64), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_audit_logs_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_logs")),
    )
    op.create_index(
        "ix_audit_logs_action_created", "audit_logs", ["action", "created_at"], unique=False
    )
    op.create_index(
        "ix_audit_logs_actor_created", "audit_logs", ["actor_user_id", "created_at"], unique=False
    )
    op.create_table(
        "avatar_customizations",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("avatar_name", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=32), server_default="avatar", nullable=False),
        sa.Column("body", sa.String(length=1), nullable=False),
        sa.Column("skin_tone", sa.String(length=7), nullable=False),
        sa.Column("hair_style", sa.String(length=8), nullable=False),
        sa.Column("hair_color", sa.String(length=7), nullable=False),
        sa.Column("top_style", sa.String(length=8), nullable=False),
        sa.Column("top_color", sa.String(length=7), nullable=False),
        sa.Column("bottom_style", sa.String(length=10), nullable=False),
        sa.Column("bottom_color", sa.String(length=7), nullable=False),
        sa.Column("shoe_color", sa.String(length=7), nullable=False),
        sa.Column("accent_color", sa.String(length=7), nullable=False),
        sa.Column(
            "accessories", sa.ARRAY(sa.String(length=12)), server_default="{}", nullable=False
        ),
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
            "accent_color ~ '^#[0-9a-f]{6}$'",
            name=op.f("ck_avatar_customizations_accent_color_hex"),
        ),
        sa.CheckConstraint("body IN ('a','b')", name=op.f("ck_avatar_customizations_body")),
        sa.CheckConstraint(
            "bottom_color ~ '^#[0-9a-f]{6}$'",
            name=op.f("ck_avatar_customizations_bottom_color_hex"),
        ),
        sa.CheckConstraint(
            "bottom_style IN ('trousers','shorts')",
            name=op.f("ck_avatar_customizations_bottom_style"),
        ),
        sa.CheckConstraint(
            "hair_color ~ '^#[0-9a-f]{6}$'", name=op.f("ck_avatar_customizations_hair_color_hex")
        ),
        sa.CheckConstraint(
            "hair_style IN ('short','long','bun','buzz')",
            name=op.f("ck_avatar_customizations_hair_style"),
        ),
        sa.CheckConstraint(
            "shoe_color ~ '^#[0-9a-f]{6}$'", name=op.f("ck_avatar_customizations_shoe_color_hex")
        ),
        sa.CheckConstraint(
            "skin_tone ~ '^#[0-9a-f]{6}$'", name=op.f("ck_avatar_customizations_skin_tone_hex")
        ),
        sa.CheckConstraint(
            "top_color ~ '^#[0-9a-f]{6}$'", name=op.f("ck_avatar_customizations_top_color_hex")
        ),
        sa.CheckConstraint(
            "top_style IN ('hoodie','tee')", name=op.f("ck_avatar_customizations_top_style")
        ),
        sa.CheckConstraint(
            "cardinality(accessories) <= 3", name=op.f("ck_avatar_customizations_accessory_count")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_avatar_customizations_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_avatar_customizations")),
    )
    op.create_table(
        "buildings",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("building", sa.String(length=32), nullable=False),
        sa.Column("levels", sa.Integer(), nullable=True),
        sa.Column("height_m", sa.Float(), nullable=False),
        sa.Column("min_height_m", sa.Float(), server_default="0", nullable=False),
        sa.Column("height_source", sa.String(length=16), nullable=False),
        sa.Column("colour", sa.String(length=16), nullable=True),
        sa.Column("roof_shape", sa.String(length=32), nullable=True),
        sa.Column("address", sa.String(length=200), nullable=True),
        sa.Column(
            "footprint",
            geoalchemy2.Geometry(
                geometry_type="MULTIPOLYGON",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=True),
        sa.Column("name_en", sa.String(length=200), nullable=True),
        sa.Column("name_km", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_buildings_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_buildings")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_buildings_osm"),
    )
    op.create_index(
        "ix_buildings_footprint", "buildings", ["footprint"], unique=False, postgresql_using="gist"
    )
    op.create_index("ix_buildings_region", "buildings", ["region_id"], unique=False)
    op.create_table(
        "contact_verifications",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("channel", sa.String(length=8), nullable=False),
        sa.Column("destination", sa.String(length=255), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "channel IN ('email','phone')", name=op.f("ck_contact_verifications_channel_valid")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_contact_verifications_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contact_verifications")),
    )
    op.create_index(
        "ix_contact_verifications_user_created",
        "contact_verifications",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "dataset_imports",
        sa.Column("region_id", sa.Uuid(), nullable=True),
        sa.Column("source", sa.String(length=120), nullable=False),
        sa.Column("licence", sa.String(length=120), nullable=False),
        sa.Column("osm_base_timestamp", sa.String(length=32), nullable=True),
        sa.Column("stats", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "imported_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_dataset_imports_region_id_geographic_regions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dataset_imports")),
    )
    op.create_table(
        "land_areas",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column(
            "geom",
            geoalchemy2.Geometry(
                geometry_type="MULTIPOLYGON",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=True),
        sa.Column("name_en", sa.String(length=200), nullable=True),
        sa.Column("name_km", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_land_areas_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_land_areas")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_land_areas_osm"),
    )
    op.create_index(
        "ix_land_areas_geom", "land_areas", ["geom"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "player_spawn_points",
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("name_km", sa.String(length=120), nullable=True),
        sa.Column("description", sa.String(length=300), nullable=False),
        sa.Column(
            "location",
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
        sa.Column("heading_deg", sa.Float(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_player_spawn_points_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_spawn_points")),
        sa.UniqueConstraint("slug", name=op.f("uq_player_spawn_points_slug")),
    )
    op.create_index(
        "ix_player_spawn_points_location",
        "player_spawn_points",
        ["location"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_table(
        "roads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("highway", sa.String(length=32), nullable=False),
        sa.Column("ref", sa.String(length=32), nullable=True),
        sa.Column("lanes", sa.Integer(), nullable=True),
        sa.Column("oneway", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("width_m", sa.Float(), nullable=False),
        sa.Column("width_source", sa.String(length=16), nullable=False),
        sa.Column("surface", sa.String(length=32), nullable=True),
        sa.Column("layer", sa.Integer(), server_default="0", nullable=False),
        sa.Column("is_bridge", sa.Boolean(), server_default="false", nullable=False),
        sa.Column(
            "geom",
            geoalchemy2.Geometry(
                geometry_type="LINESTRING",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeomFromEWKT",
                name="geometry",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=True),
        sa.Column("name_en", sa.String(length=200), nullable=True),
        sa.Column("name_km", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_roads_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roads")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_roads_osm"),
    )
    op.create_index("ix_roads_geom", "roads", ["geom"], unique=False, postgresql_using="gist")
    op.create_index("ix_roads_region", "roads", ["region_id"], unique=False)
    op.create_table(
        "sessions",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sessions_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
    )
    op.create_index("ix_sessions_user_active", "sessions", ["user_id", "revoked_at"], unique=False)
    op.create_table(
        "street_features",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column(
            "location",
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
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_street_features_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_street_features")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_street_features_osm"),
    )
    op.create_index(
        "ix_street_features_location",
        "street_features",
        ["location"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_table(
        "user_addresses",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.String(length=40), nullable=False),
        sa.Column(
            "location",
            geoalchemy2.Geography(
                geometry_type="POINT",
                srid=4326,
                dimension=2,
                spatial_index=False,
                from_text="ST_GeogFromText",
                name="geography",
                nullable=False,
            ),
            nullable=False,
        ),
        sa.Column("address_line", sa.String(length=200), nullable=False),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
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
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_addresses_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_addresses")),
    )
    op.create_index(
        "ix_user_addresses_location",
        "user_addresses",
        ["location"],
        unique=False,
        postgresql_using="gist",
    )
    op.create_index("ix_user_addresses_user", "user_addresses", ["user_id"], unique=False)
    op.create_index(
        "uq_user_addresses_one_default",
        "user_addresses",
        ["user_id"],
        unique=True,
        postgresql_where="is_default",
    )
    op.create_table(
        "user_roles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by_id", sa.Uuid(), nullable=True),
        sa.Column("decision_reason", sa.String(length=500), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.CheckConstraint(
            "role IN ('visitor','buyer','seller','driver','admin')",
            name=op.f("ck_user_roles_role_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('active','pending','rejected','revoked')",
            name=op.f("ck_user_roles_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["decided_by_id"],
            ["users.id"],
            name=op.f("fk_user_roles_decided_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_user_roles_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_roles")),
        sa.UniqueConstraint("user_id", "role", name="uq_user_roles_user_role"),
    )
    op.create_index("ix_user_roles_status_role", "user_roles", ["status", "role"], unique=False)
    op.create_table(
        "world_chunks",
        sa.Column("key", sa.String(length=24), nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("ix", sa.Integer(), nullable=False),
        sa.Column("iz", sa.Integer(), nullable=False),
        sa.Column(
            "bounds",
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
        sa.Column("building_count", sa.Integer(), nullable=False),
        sa.Column("road_count", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("etag", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_world_chunks_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_world_chunks")),
        sa.UniqueConstraint("ix", "iz", name="uq_world_chunks_ix_iz"),
    )
    op.create_index(
        "ix_world_chunks_bounds", "world_chunks", ["bounds"], unique=False, postgresql_using="gist"
    )
    op.create_table(
        "landmarks",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("category", sa.String(length=16), nullable=False),
        sa.Column("subtype", sa.String(length=48), nullable=False),
        sa.Column("importance", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "location",
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
        sa.Column("building_id", sa.BigInteger(), nullable=True),
        sa.Column("osm_type", sa.String(length=8), nullable=False),
        sa.Column("osm_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=True),
        sa.Column("name_en", sa.String(length=200), nullable=True),
        sa.Column("name_km", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(
            ["building_id"],
            ["buildings.id"],
            name=op.f("fk_landmarks_building_id_buildings"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_landmarks_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_landmarks")),
        sa.UniqueConstraint("osm_type", "osm_id", name="uq_landmarks_osm"),
    )
    op.create_index(
        "ix_landmarks_location", "landmarks", ["location"], unique=False, postgresql_using="gist"
    )
    op.create_index(
        "ix_landmarks_name_trgm",
        "landmarks",
        ["name"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("display_name", sa.String(length=48), nullable=False),
        sa.Column("preferred_language", sa.String(length=2), nullable=False),
        sa.Column("world_visible", sa.Boolean(), nullable=True),
        sa.Column("spawn_point_id", sa.Uuid(), nullable=True),
        sa.Column("roles_chosen_at", sa.DateTime(timezone=True), nullable=True),
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
            "preferred_language IN ('en','km')", name=op.f("ck_user_profiles_language")
        ),
        sa.ForeignKeyConstraint(
            ["spawn_point_id"],
            ["player_spawn_points.id"],
            name=op.f("fk_user_profiles_spawn_point_id_player_spawn_points"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_profiles_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_user_profiles")),
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_table("user_profiles")
    op.drop_index(
        "ix_landmarks_name_trgm",
        table_name="landmarks",
        postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.drop_index("ix_landmarks_location", table_name="landmarks", postgresql_using="gist")
    op.drop_table("landmarks")
    op.drop_index("ix_world_chunks_bounds", table_name="world_chunks", postgresql_using="gist")
    op.drop_table("world_chunks")
    op.drop_index("ix_user_roles_status_role", table_name="user_roles")
    op.drop_table("user_roles")
    op.drop_index(
        "uq_user_addresses_one_default", table_name="user_addresses", postgresql_where="is_default"
    )
    op.drop_index("ix_user_addresses_user", table_name="user_addresses")
    op.drop_index(
        "ix_user_addresses_location", table_name="user_addresses", postgresql_using="gist"
    )
    op.drop_table("user_addresses")
    op.drop_index(
        "ix_street_features_location", table_name="street_features", postgresql_using="gist"
    )
    op.drop_table("street_features")
    op.drop_index("ix_sessions_user_active", table_name="sessions")
    op.drop_table("sessions")
    op.drop_index("ix_roads_region", table_name="roads")
    op.drop_index("ix_roads_geom", table_name="roads", postgresql_using="gist")
    op.drop_table("roads")
    op.drop_index(
        "ix_player_spawn_points_location", table_name="player_spawn_points", postgresql_using="gist"
    )
    op.drop_table("player_spawn_points")
    op.drop_index("ix_land_areas_geom", table_name="land_areas", postgresql_using="gist")
    op.drop_table("land_areas")
    op.drop_table("dataset_imports")
    op.drop_index("ix_contact_verifications_user_created", table_name="contact_verifications")
    op.drop_table("contact_verifications")
    op.drop_index("ix_buildings_region", table_name="buildings")
    op.drop_index("ix_buildings_footprint", table_name="buildings", postgresql_using="gist")
    op.drop_table("buildings")
    op.drop_table("avatar_customizations")
    op.drop_index("ix_audit_logs_actor_created", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action_created", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_table("users")
    op.drop_index(
        "ix_places_search_trgm",
        table_name="places",
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )
    op.drop_index("ix_places_location", table_name="places", postgresql_using="gist")
    op.drop_table("places")
    op.drop_index(
        "ix_geographic_regions_boundary", table_name="geographic_regions", postgresql_using="gist"
    )
    op.drop_table("geographic_regions")
    # ### end Alembic commands ###
