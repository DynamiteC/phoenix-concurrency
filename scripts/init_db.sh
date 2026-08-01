#!/usr/bin/env bash
# Create the database and apply every DDL file in sql/schema/. Idempotent.
#   ./scripts/init_db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
DB="${CH_DATABASE:-phoenix}"

CH_DATABASE=default ./scripts/ch.sh --query "CREATE DATABASE IF NOT EXISTS $DB"

for f in sql/schema/*.sql; do
  echo "== $f"
  ./scripts/ch.sh --queries-file "$f"
done

./scripts/ch.sh --format PrettyCompact --query "SHOW TABLES"
