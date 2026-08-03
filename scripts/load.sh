#!/usr/bin/env bash
# Load a CSV into ClickHouse Cloud. Re-run this verbatim on the unseen-day file.
#
#   ./scripts/load.sh --dry-run data/ch-hackathon-raw-data.csv
#   ./scripts/load.sh data/ch-hackathon-raw-data.csv raw_events_landing
#   TABLE_PREFIX=unseen_ ./scripts/load.sh data/unseen.csv raw_events_landing phoenix_graded
#
# The third argument is the TARGET DATABASE, defaulting to $CH_DATABASE and then to phoenix_graded.
# One database per dataset generation is the structural replacement for the social rule
# "announce your DDL": the unseen day lives in phoenix_unseen under normal table names.
# TABLE_PREFIX (unset by default) exists for co-locating a second generation inside one
# database when that is ever wanted; see scripts/prefix_sql.sh.
#
# TABLE_PREFIX, unset by default, is prepended to $TABLE before it is used as either the INSERT
# target or the row-count table below, matching the shared name list in scripts/prefix_sql.sh
# (not sourced here: this script never reads a .sql file, so there is no query text to rewrite,
# only the one table name already passed as an argument).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

DRY=0
[ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }
FILE="${1:?usage: ./scripts/load.sh [--dry-run] <file.csv> [table] [database]}"
TABLE="${2:+${TABLE_PREFIX:-}$2}"
DB="${3:-${CH_DATABASE:-phoenix_graded}}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

if [ "$DRY" = 1 ]; then
  # ponytail: clickhouse local reads the CSV in place, no cloud round-trip
  clickhouse local --query "DESCRIBE file('$FILE', CSVWithNames)"
  clickhouse local --query "SELECT count() AS rows FROM file('$FILE', CSVWithNames)"
  exit 0
fi

[ -n "$TABLE" ] || { echo "table name required for a real load" >&2; exit 1; }
[ -n "${CH_PASSWORD:-}" ] || { echo "no CH_PASSWORD: cp .env.example .env and fill it in" >&2; exit 1; }
echo "loading $FILE -> $DB.$TABLE" >&2
time clickhouse client --host "$CH_HOST" --secure --port "${CH_PORT:-9440}" \
  --user "${CH_USER:-default}" --password "$CH_PASSWORD" --database "$DB" \
  --query "INSERT INTO $TABLE FORMAT CSVWithNames" < "$FILE"

# Loaded-row count against source-row count, every time. A CSV that loses rows to a quoting
# error loads without complaint and the loss is invisible until a number is wrong much later.
src=$(( $(wc -l < "$FILE") - 1 ))
got="$(clickhouse client --host "$CH_HOST" --secure --port "${CH_PORT:-9440}" \
  --user "${CH_USER:-default}" --password "$CH_PASSWORD" --database "$DB" \
  --query "SELECT count() FROM $( [ "$TABLE" = "${TABLE_PREFIX:-}raw_events_landing" ] && echo "${TABLE_PREFIX:-}raw_events" || echo "$TABLE" )")"
echo "source data rows: $src   rows now in $DB: $got" >&2
