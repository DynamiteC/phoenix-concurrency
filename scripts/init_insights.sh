#!/usr/bin/env bash
# Apply every DDL file in sql/insights/schema/ to a database. Idempotent.
#
#   ./scripts/init_insights.sh                                     # $CH_DATABASE, then phoenix_live
#   ./scripts/init_insights.sh phoenix_live
#   TABLE_PREFIX=unseen_ ./scripts/init_insights.sh phoenix_graded  # unseen tables, frozen
#
# SEPARATE FROM init_db.sh ON PURPOSE. init_db.sh globs sql/schema/, so an insight table dropped
# into that directory would be created inside the original corpus's database by any future init
# or by rebuild_swap.sh, which builds its shadow from those files. The concurrency engine and the
# insight layer have different lifecycles and different blast radii, so they get different
# directories and different appliers.
#
# TABLE_PREFIX, unset by default, rewrites every physical name in each schema file to
# ${TABLE_PREFIX}name before it runs, same mechanism and same shared name list as init_db.sh; see
# scripts/prefix_sql.sh.
#
# Refuses to run against the original corpus's frozen database with no prefix set. That is the
# validated generation-1 data and this workstream does not write insight tables into it under
# their normal names; the insight layer for the original corpus lives in phoenix_live, and the
# unseen day's insight tables belong in phoenix_graded ONLY under TABLE_PREFIX=unseen_. Override
# with ALLOW_PHOENIX=1 if that ever stops being true, which is a decision, not a flag.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/prefix_sql.sh
trap cleanup_prefixed_sql_files EXIT
set -a; [ -f .env ] && . ./.env; set +a
DB="${1:-${CH_DATABASE:-phoenix_live}}"
export CH_DATABASE="$DB"

if [ "$DB" = "phoenix_graded" ] && [ -z "${TABLE_PREFIX:-}" ] && [ "${ALLOW_PHOENIX:-0}" != "1" ]; then
  echo "REFUSING: phoenix_graded holds the frozen original corpus under its normal table names." >&2
  echo "  The insight layer for the original corpus lives in phoenix_live. To init the unseen" >&2
  echo "  day's insight tables here instead, set TABLE_PREFIX=unseen_. See docs/DECISIONS.md D9" >&2
  echo "  and STATUS.md." >&2
  exit 1
fi

CH_DATABASE=default ./scripts/ch.sh --query "CREATE DATABASE IF NOT EXISTS $DB"

for f in sql/insights/schema/*.sql; do
  [ -e "$f" ] || { echo "no insight schema files yet"; exit 0; }
  echo "== $f${TABLE_PREFIX:+ (prefix: $TABLE_PREFIX)}"
  ./scripts/ch.sh --queries-file "$(prefixed_sql_file "$f")"
done

./scripts/ch.sh --format PrettyCompact --query "
  SELECT name, engine FROM system.tables
  WHERE database = currentDatabase()
    AND name IN (SELECT name FROM system.tables WHERE database = currentDatabase())
    AND (name LIKE '%insight%' OR name LIKE '%late_event%' OR name LIKE '%audience%'
         OR name LIKE '%transitions%' OR name LIKE '%cohorts%' OR name LIKE '%spike%'
         OR name LIKE '%playback_health%')
  ORDER BY name"
