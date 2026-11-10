#!/bin/sh
# Creates the automated-test database (with PostGIS) on the first start of an empty volume.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE DATABASE ${POSTGRES_DB}_test OWNER ${POSTGRES_USER};
  CREATE DATABASE ${POSTGRES_DB}_e2e OWNER ${POSTGRES_USER};
SQL
for db in "$POSTGRES_DB" "${POSTGRES_DB}_test" "${POSTGRES_DB}_e2e"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-SQL
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL
done
