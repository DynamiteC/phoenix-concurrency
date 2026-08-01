#!/usr/bin/env bash
# Thin wrapper: clickhouse client against the service in .env. Everything else calls this.
#
#   ./scripts/ch.sh --query "SELECT 1"
#   ./scripts/ch.sh --queries-file sql/schema/raw_events.sql
set -euo pipefail
cd "$(dirname "$0")/.."
_db="${CH_DATABASE:-}"                       # a caller-set CH_DATABASE wins over .env
set -a; [ -f .env ] && . ./.env; set +a
[ -n "$_db" ] && CH_DATABASE="$_db"
: "${CH_HOST:?no CH_HOST: cp .env.example .env and fill it in}"

exec clickhouse client \
  --host "$CH_HOST" --secure --port "${CH_PORT:-9440}" \
  --user "${CH_USER:-default}" --password "${CH_PASSWORD:-}" \
  --database "${CH_DATABASE:-default}" \
  --session_timezone UTC "$@"   # local runs are Asia/Kolkata, the service is UTC: pin both
