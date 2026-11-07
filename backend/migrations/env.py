"""Alembic migration environment (async, psycopg 3, PostGIS)."""

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app import models  # noqa: F401  (registers all tables on Base.metadata)
from app.core.config import settings
from app.core.database import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# The URL always comes from application settings (DATABASE_URL), never from alembic.ini.
# A caller (e.g. the test suite) may override it via `config.attributes["database_url"]`.
config.set_main_option(
    "sqlalchemy.url", config.attributes.get("database_url", settings.database_url)
)

target_metadata = Base.metadata

# PostGIS, tiger and topology own tables in the database; never autogenerate against them.
_OWN_TABLES = set(Base.metadata.tables)


def include_object(obj, name, type_, reflected, compare_to):
    return not (type_ == "table" and reflected and name not in _OWN_TABLES)


def render_item(type_, obj, autogen_context):
    """Render GeoAlchemy2 column types with their import."""
    if type_ == "type" and type(obj).__module__.startswith("geoalchemy2"):
        autogen_context.imports.add("import geoalchemy2")
        return f"geoalchemy2.{obj!r}"
    return False


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        include_object=include_object,
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        include_object=include_object,
        render_item=render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
