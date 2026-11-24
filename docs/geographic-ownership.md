# Geographic foundation: shared source membership

Local implementation on `milestone/geographic-foundation`, continuing the
[initial audit](geographic-foundation-audit.md). No GitHub push, live database migration,
new region import, or avatar replacement was performed in this slice.

## Behavior

Previously, each road/building/area/landmark/street feature belonged to one region.
Importing the same OSM identity for a second region could move its ownership; pruning a
region could remove a feature still needed by another source.

Migration `0007` adds five membership tables with real foreign keys, each keyed by feature ID
and region ID. It backfills existing ownership without changing feature rows or IDs.
The importer now synchronizes these associations alongside its existing OSM upserts:

- The same OSM identity retains one database ID across datasets.
- A secondary dataset records membership without overwriting the primary owner's geometry
  or attributes. No footprint or shoreline union is inferred.
- A refresh removes only that dataset's memberships. A shared feature survives.
- If the primary owner stops supplying a feature, a remaining member becomes its primary
  owner, preserving the ID. Last canonical attributes are retained until that owner refreshes.
  This is **not** automatic newest-snapshot reconciliation.
- A feature is pruned only after its final dataset membership disappears.
- Road/building ID lookup uses membership rather than assuming primary ownership.
- `import_all` takes a transaction-scoped PostgreSQL advisory lock to serialize refreshes.
  `sync_features` is an internal helper; callers must use the import transaction/locking path.

Legacy `region_id` fields remain for current rendering, marketplace, routing and multiplayer
consumers. Whole-region deletion is not a supported administrative operation: those legacy
foreign keys still cascade, and user/spawn references also depend on regions remaining stable.

## Files

| File | Change |
|---|---|
| `backend/app/models/geo.py` | Five feature↔region association tables with cascading FKs |
| `backend/migrations/versions/20261124_0007_geographic_membership.py` | Additive schema migration and existing-row backfill; downgrade removes only associations |
| `backend/app/geography/ownership.py` | Batched source synchronization, primary-owner preservation/handoff, orphan pruning |
| `backend/app/geography/importer.py` | Integrate synchronization, membership-based ID lookup and import serialization |
| `backend/tests/test_geographic_ownership.py` | Five-model lifecycle regression, real reimport ID stability, populated-table migration backfill |

Only the dedicated `_test` database is migrated by the tests. A later deployment must run the
normal Alembic upgrade before running this importer; old deployed backend containers remain
unchanged for now.

Validation: **41 integration tests passed** across geography, streetscape, shared ownership
and marketplace claims. The migration test downgrades/upgrades populated tables inside a
rolled-back test transaction and checks that every feature ID/primary owner is unchanged and
backfilled correctly. All **7 offline preflight tests** pass. Changed Python files pass Ruff
lint/format checks, and `git diff --check` is clean.

Startup correction after the first local Docker upgrade: the readiness endpoint's expected
schema revision in `backend/app/api/v1/router.py` must be `0007`. Leaving it at `0006` returns
503 even after a successful migration and API startup. Both tests in `tests/test_health.py`
pass with the correction; include them in future migration regression runs.

## Scope and next step

Coverage remains **2.7849 km²**; snapshot validation and the shared-chunk guard still apply.
The new memberships are prerequisites, not a claim that independent neighboring imports
or cross-region gameplay work yet.

Next implement canonical shared chunk assembly with source provenance and deduplication,
then verify roads/water/buildings at seams before changing the guard. Region-independent
routing and client/server travel limits still need implementation and tests. No new
coordinates, buildings, POIs, or geographic sources were added here.

No renderer changes were made in this slice. The prior real-GPU browser baseline remains the
reference; no new performance improvement or FPS guarantee is claimed.
