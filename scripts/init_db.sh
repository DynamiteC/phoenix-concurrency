#!/usr/bin/env bash
# Create the database and apply every DDL file in sql/schema/. Idempotent.
#
#   ./scripts/init_db.sh                            # $CH_DATABASE, then phoenix_graded
#   ./scripts/init_db.sh phoenix_live                  # one database per generation
#   TABLE_PREFIX=unseen_ ./scripts/init_db.sh phoenix_graded   # unseen tables, same database
#
# Every object comes from a versioned file in sql/schema/. No ad-hoc DDL, ever: an
# out-of-band ALTER against a live table cost this project a day, and "announce your DDL"
# has now failed twice as a control.
#
# TABLE_PREFIX, unset by default, lets a second dataset generation share one database without
# name collisions: every physical name in each schema file is rewritten to ${TABLE_PREFIX}name
# before it runs. Unused in the current deployment (each generation has its own database); see
# scripts/prefix_sql.sh for the shared name list.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/prefix_sql.sh
trap cleanup_prefixed_sql_files EXIT
set -a; [ -f .env ] && . ./.env; set +a
DB="${1:-${CH_DATABASE:-phoenix_graded}}"
export CH_DATABASE="$DB"

CH_DATABASE=default ./scripts/ch.sh --query "CREATE DATABASE IF NOT EXISTS $DB"

for f in sql/schema/*.sql; do
  echo "== $f${TABLE_PREFIX:+ (prefix: $TABLE_PREFIX)}"
  ./scripts/ch.sh --queries-file "$(prefixed_sql_file "$f")"
done

./scripts/ch.sh --format PrettyCompact --query "SHOW TABLES"
