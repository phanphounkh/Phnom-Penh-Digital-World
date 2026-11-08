"""Phase 3: multiplayer and social (world rooms, player sessions, friendships, blocks,
mutes, chat messages, player reports) and the chat-mute moderation field.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-08 08:05:19.675124

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "friendships",
        sa.Column("requester_id", sa.Uuid(), nullable=False),
        sa.Column("addressee_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
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
            "status IN ('pending','accepted')", name=op.f("ck_friendships_status_valid")
        ),
        sa.CheckConstraint("requester_id <> addressee_id", name=op.f("ck_friendships_not_self")),
        sa.ForeignKeyConstraint(
            ["addressee_id"],
            ["users.id"],
            name=op.f("fk_friendships_addressee_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_friendships_requester_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_friendships")),
    )
    op.create_index(
        "ix_friendships_addressee_status", "friendships", ["addressee_id", "status"], unique=False
    )
    op.create_index(
        "uq_friendships_pair",
        "friendships",
        [
            sa.text("least(requester_id, addressee_id)"),
            sa.text("greatest(requester_id, addressee_id)"),
        ],
        unique=True,
    )
    op.create_table(
        "player_reports",
        sa.Column("reporter_id", sa.Uuid(), nullable=False),
        sa.Column("reported_id", sa.Uuid(), nullable=False),
        sa.Column("reason", sa.String(length=24), nullable=False),
        sa.Column("details", sa.String(length=1000), nullable=True),
        sa.Column(
            "context", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.String(length=10), server_default="open", nullable=False),
        sa.Column("action", sa.String(length=24), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("resolved_by_id", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
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
            "reason IN ('harassment','hate','spam','cheating','inappropriate_name','other')",
            name=op.f("ck_player_reports_reason_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('open','resolved','dismissed')", name=op.f("ck_player_reports_status_valid")
        ),
        sa.ForeignKeyConstraint(
            ["reported_id"],
            ["users.id"],
            name=op.f("fk_player_reports_reported_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["reporter_id"],
            ["users.id"],
            name=op.f("fk_player_reports_reporter_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["resolved_by_id"],
            ["users.id"],
            name=op.f("fk_player_reports_resolved_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_reports")),
    )
    op.create_index(
        "ix_player_reports_status_created", "player_reports", ["status", "created_at"], unique=False
    )
    op.create_table(
        "user_blocks",
        sa.Column("blocker_id", sa.Uuid(), nullable=False),
        sa.Column("blocked_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("blocker_id <> blocked_id", name=op.f("ck_user_blocks_not_self")),
        sa.ForeignKeyConstraint(
            ["blocked_id"],
            ["users.id"],
            name=op.f("fk_user_blocks_blocked_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"],
            ["users.id"],
            name=op.f("fk_user_blocks_blocker_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("blocker_id", "blocked_id", name=op.f("pk_user_blocks")),
    )
    op.create_index(op.f("ix_user_blocks_blocked_id"), "user_blocks", ["blocked_id"], unique=False)
    op.create_table(
        "user_mutes",
        sa.Column("muter_id", sa.Uuid(), nullable=False),
        sa.Column("muted_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("muter_id <> muted_id", name=op.f("ck_user_mutes_not_self")),
        sa.ForeignKeyConstraint(
            ["muted_id"],
            ["users.id"],
            name=op.f("fk_user_mutes_muted_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["muter_id"],
            ["users.id"],
            name=op.f("fk_user_mutes_muter_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("muter_id", "muted_id", name=op.f("pk_user_mutes")),
    )
    op.create_table(
        "world_rooms",
        sa.Column("region_id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("capacity", sa.Integer(), server_default="150", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
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
            ["region_id"],
            ["geographic_regions.id"],
            name=op.f("fk_world_rooms_region_id_geographic_regions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_world_rooms")),
        sa.UniqueConstraint("slug", name=op.f("uq_world_rooms_slug")),
    )
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("room_id", sa.Uuid(), nullable=True),
        sa.Column("sender_id", sa.Uuid(), nullable=False),
        sa.Column("recipient_id", sa.Uuid(), nullable=True),
        sa.Column("channel", sa.String(length=8), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("flagged", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(channel = 'direct') = (recipient_id IS NOT NULL)",
            name=op.f("ck_chat_messages_direct_has_recipient"),
        ),
        sa.CheckConstraint(
            "channel IN ('nearby','world','direct')", name=op.f("ck_chat_messages_channel_valid")
        ),
        sa.ForeignKeyConstraint(
            ["recipient_id"],
            ["users.id"],
            name=op.f("fk_chat_messages_recipient_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["world_rooms.id"],
            name=op.f("fk_chat_messages_room_id_world_rooms"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["sender_id"],
            ["users.id"],
            name=op.f("fk_chat_messages_sender_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_messages")),
    )
    op.create_index(
        "ix_chat_messages_recipient_read",
        "chat_messages",
        ["recipient_id", "read_at"],
        unique=False,
    )
    op.create_index(
        "ix_chat_messages_room_created", "chat_messages", ["room_id", "created_at"], unique=False
    )
    op.create_index(
        "ix_chat_messages_sender_created",
        "chat_messages",
        ["sender_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "player_sessions",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("room_id", sa.Uuid(), nullable=False),
        sa.Column("auth_session_id", sa.Uuid(), nullable=True),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("disconnect_reason", sa.String(length=32), nullable=True),
        sa.Column("last_x", sa.Float(), nullable=True),
        sa.Column("last_z", sa.Float(), nullable=True),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=True),
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["auth_session_id"],
            ["sessions.id"],
            name=op.f("fk_player_sessions_auth_session_id_sessions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["world_rooms.id"],
            name=op.f("fk_player_sessions_room_id_world_rooms"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_player_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_sessions")),
    )
    op.create_index(
        "ix_player_sessions_open",
        "player_sessions",
        ["room_id"],
        unique=False,
        postgresql_where="disconnected_at IS NULL",
    )
    op.create_index(
        "ix_player_sessions_user_connected",
        "player_sessions",
        ["user_id", "connected_at"],
        unique=False,
    )
    op.add_column(
        "user_profiles", sa.Column("chat_muted_until", sa.DateTime(timezone=True), nullable=True)
    )
    # ### end Alembic commands ###


def downgrade() -> None:
    """Downgrade schema."""
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_column("user_profiles", "chat_muted_until")
    op.drop_index("ix_player_sessions_user_connected", table_name="player_sessions")
    op.drop_index(
        "ix_player_sessions_open",
        table_name="player_sessions",
        postgresql_where="disconnected_at IS NULL",
    )
    op.drop_table("player_sessions")
    op.drop_index("ix_chat_messages_sender_created", table_name="chat_messages")
    op.drop_index("ix_chat_messages_room_created", table_name="chat_messages")
    op.drop_index("ix_chat_messages_recipient_read", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_table("world_rooms")
    op.drop_table("user_mutes")
    op.drop_index(op.f("ix_user_blocks_blocked_id"), table_name="user_blocks")
    op.drop_table("user_blocks")
    op.drop_index("ix_player_reports_status_created", table_name="player_reports")
    op.drop_table("player_reports")
    op.drop_index("uq_friendships_pair", table_name="friendships")
    op.drop_index("ix_friendships_addressee_status", table_name="friendships")
    op.drop_table("friendships")
    # ### end Alembic commands ###
