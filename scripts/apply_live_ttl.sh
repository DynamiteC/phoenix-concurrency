#!/usr/bin/env bash
# Apply a 48-hour DELETE TTL to every live-ingest table, so a continuous producer+ticker run
# ages itself out instead of accumulating forever and eventually re-tripping TOO_MANY_PARTS or
# a ClickHouse Cloud storage/part-count limit.
#
#   ./scripts/apply_live_ttl.sh                  # $LIVE_DB, then phoenix_live
#   ./scripts/apply_live_ttl.sh phoenix_live       # a named live database
#   LIVE_TTL_HOURS=24 ./scripts/apply_live_ttl.sh phoenix_live   # override the window
#
# WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF sql/schema/*.sql. The schema files are shared
# by every database this repo touches, including the two frozen graded corpora. A TTL baked
# into CREATE TABLE would delete rows out from under a benchmark the moment 48 hours pass,
# which is exactly the outcome the guard below exists to make impossible. This script is
# opt-in, per database, and only ever run by hand against a live database.
#
# WHY 48 HOURS. The console and the v2 insight views only ever ask about recent activity (spikes,
# retention windows, lateness, forecast horizon), none of which looks back further than a day or
# two. Past that, rows are pure carrying cost: more parts, more merge pressure, more of the
# storage budget that hit its ceiling on the last continuous run. Deleting via TTL rather than a
# DROP PARTITION cron keeps this a background merge concern instead of a script that has to be
# invoked on a schedule to stay ahead of growth.
#
# TABLE -> TIME COLUMN MAP, read from each schema file rather than assumed, per
# clickhouse-best-practices: three different derived tables use three different time columns
# and a copy-pasted column name silently no-ops the TTL instead of erroring.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

DB="${1:-${LIVE_DB:-phoenix_live}}"

# REFUSE ON THE FROZEN CORPORA. phoenix_graded holds the frozen original corpus (normal table
# names) AND the frozen unseen day (unseen_-prefixed tables) in the same database: docs pin exact
# row counts against both, and a TTL would start silently deleting rows the moment they cross 48
# hours old, which for a frozen corpus is immediately. The legacy names are kept in the refusal
# list too, in case a service still carries a database from before this database was renamed to
# phoenix_graded. This check runs before anything else touches the network.
case "$DB" in
  phoenix_graded|phoenix|phoenix_graded|phoenix_unseen)
    echo "REFUSING: '$DB' is a frozen corpus, not a live-ingest database." >&2
    echo "  A TTL here would delete rows out of the frozen original corpus or the frozen unseen" >&2
    echo "  day (unseen_-prefixed tables) as soon as they cross the TTL window, and there is no" >&2
    echo "  undo for that." >&2
    echo "  Pass the live database explicitly, e.g.: ./scripts/apply_live_ttl.sh phoenix_live" >&2
    exit 1
    ;;
esac

export CH_DATABASE="$DB"
TTL_HOURS="${LIVE_TTL_HOURS:-48}"

# alter_sync=2, same reasoning as reset_live.sh: on Cloud SharedMergeTree a MODIFY TTL that
# only one replica has applied can leave a concurrent reader looking at a table that has not
# yet agreed to expire its own rows. Waiting for every replica costs one ALTER's worth of
# latency and buys certainty instead of a race.
ch() { ./scripts/ch.sh --alter_sync=2 "$@"; }

# $1 = table, $2 = TTL expression (already wrapped in toDateTime() where the column is
# DateTime64, bare where it is already DateTime -- MODIFY TTL accepts either, this just keeps
# the printed statement honest about the column's real type).
apply_ttl() {
  local table="$1" expr="$2"
  local sql="ALTER TABLE ${table} MODIFY TTL ${expr} + INTERVAL ${TTL_HOURS} HOUR DELETE"
  echo "$sql"
  ch --query "$sql"
}

skip() {  # $1 = table, $2 = reason
  echo "SKIPPED ${1}: ${2}"
}

echo "== applying ${TTL_HOURS}h DELETE TTL to live tables in $DB"

# --- sql/schema -------------------------------------------------------------------------
# raw_events: source of truth, as specified.
apply_ttl raw_events "toDateTime(event_timestamp)"

# raw_events_landing: ENGINE = Null, a pure pass-through with no rows ever resident (see
# sql/schema/01_raw_events.sql). Nothing to TTL.
skip raw_events_landing "ENGINE = Null, holds no rows"

# sql/schema/04_concurrency.sql
apply_ttl foreground_intervals "interval_start"
apply_ttl session_minute_runs "run_start"
apply_ttl concurrency_deltas "minute"

# sql/schema/05_user_concurrency.sql
apply_ttl user_minute_runs "run_start"
apply_ttl user_concurrency_deltas "minute"

# sql/schema/06_exact_concurrency.sql
apply_ttl concurrency_boundary_deltas "ts"

# --- sql/insights/schema ----------------------------------------------------------------
# 01_session_insight_facts.sql: session_start DateTime64(3), first event of the session.
apply_ttl session_insight_facts "toDateTime(session_start)"

# 02_session_state_transitions.sql: transition_at DateTime64(3).
apply_ttl session_state_transitions "toDateTime(transition_at)"

# 03_audience_minute_snapshot.sql: minute DateTime.
apply_ttl audience_minute_snapshot "minute"

# 05_content_entry_cohorts.sql: cohort_minute DateTime.
apply_ttl content_entry_cohorts "cohort_minute"

# 06_user_content_transitions.sql: transition_at DateTime64(3).
apply_ttl user_content_transitions "toDateTime(transition_at)"

# 07_user_platform_transitions.sql: transition_at DateTime64(3).
apply_ttl user_platform_transitions "toDateTime(transition_at)"

# 08_playback_health_minute.sql: minute DateTime.
apply_ttl playback_health_minute "minute"

# 09_late_event_audit.sql: event_date is PARTITION BY's Date, but the table also carries the
# full-precision event_timestamp DateTime64(3) it was derived from -- use that instead of the
# truncated Date so the TTL boundary is exact rather than rounded to a whole day.
apply_ttl late_event_audit "toDateTime(event_timestamp)"

# 10_concurrency_spike_events.sql: no PARTITION BY (it is a few thousand rows at most, see the
# table's own comment), but window_start DateTime is a real event time and a spike table has
# no reason to outlive the live window either.
apply_ttl concurrency_spike_events "window_start"

# Materialized views (raw_events_mv, concurrency_deltas_mv, user_concurrency_deltas_mv,
# concurrency_boundary_deltas_mv, late_event_audit_mv, and the insight refresh MVs) hold no
# storage of their own; they insert into the target tables above, which already carry the TTL.
skip "*_mv views" "no storage of their own; TTL lives on the target table"

echo "== done"
