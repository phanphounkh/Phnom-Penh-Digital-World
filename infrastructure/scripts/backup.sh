#!/usr/bin/env bash
# Run from the repository root. Archives include private data: keep them off public storage.
set -euo pipefail
umask 077
destination="${1:-backend/var/backups}/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$destination"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$destination/database.dump"
docker compose exec -T backend tar -cz -C /app/var/media . > "$destination/media.tar.gz"
test -s "$destination/database.dump"
test -s "$destination/media.tar.gz"
printf 'Backup saved to %s\n' "$destination"
