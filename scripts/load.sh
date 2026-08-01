#!/usr/bin/env bash
# Load a CSV into ClickHouse Cloud. Re-run this verbatim on the unseen-day file.
#
#   ./scripts/load.sh --dry-run data/ch-hackathon-raw-data.csv
#   ./scripts/load.sh data/ch-hackathon-raw-data.csv raw_events
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

DRY=0
[ "${1:-}" = "--dry-run" ] && { DRY=1; shift; }
FILE="${1:?usage: ./scripts/load.sh [--dry-run] <file.csv> [table]}"
TABLE="${2:-}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

if [ "$DRY" = 1 ]; then
  # ponytail: clickhouse local reads the CSV in place, no cloud round-trip
  clickhouse local --query "DESCRIBE file('$FILE', CSVWithNames)"
  clickhouse local --query "SELECT count() AS rows FROM file('$FILE', CSVWithNames)"
  exit 0
fi

[ -n "$TABLE" ] || { echo "table name required for a real load" >&2; exit 1; }
[ -n "${CH_PASSWORD:-}" ] || { echo "no CH_PASSWORD: cp .env.example .env and fill it in" >&2; exit 1; }
time clickhouse client --host "$CH_HOST" --secure --port "${CH_PORT:-9440}" \
  --user "${CH_USER:-default}" --password "$CH_PASSWORD" --database "${CH_DATABASE:-default}" \
  --query "INSERT INTO $TABLE FORMAT CSVWithNames" < "$FILE"
