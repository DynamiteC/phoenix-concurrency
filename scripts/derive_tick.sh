#!/usr/bin/env bash
# One incremental-derive tick, for a scheduler to call every few minutes.
#
#   ./scripts/derive_tick.sh                # tick phoenix
#   ./scripts/derive_tick.sh phoenix_next   # tick a named database
#
# Window logic: [watermark - overlap, max(event_timestamp)]. The watermark is the upper
# bound of the last successful tick, kept in .derive_watermark.<db> (gitignored, local
# state). The overlap re-derives sessions near the boundary; that is SAFE by construction,
# not by luck: 03_derive_incremental retracts everything a touched session currently
# asserts before re-asserting it from its full history, so re-touching a session is
# idempotent. The only cost of overlap is work, never correctness.
#
# ponytail: single flock per db so overlapping scheduler firings queue rather than race.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${1:-${CH_DATABASE:-phoenix}}"
export CH_DATABASE="$DB"
OVERLAP_S="${OVERLAP_S:-120}"
WM_FILE=".derive_watermark.$DB"
LOG="derive_tick.$DB.log"

exec 9>"$WM_FILE.lock"
flock 9

val() { ./scripts/ch.sh --format TSVRaw --query "$1" 2>/dev/null | head -1; }

max_ts="$(val "SELECT toString(max(event_timestamp)) FROM raw_events")"
[ -n "$max_ts" ] || { echo "$(date -u +%FT%TZ) $DB no data reachable, skipping" >>"$LOG"; exit 0; }

if [ -s "$WM_FILE" ]; then
  from_ts="$(val "SELECT toString(parseDateTimeBestEffort('$(cat "$WM_FILE")') - INTERVAL $OVERLAP_S SECOND)")"
else
  # First tick: cover the last hour rather than all history; a fuller catch-up is a
  # deliberate REBUILD or a wider FIRST_WINDOW_S, not an accident.
  from_ts="$(val "SELECT toString(parseDateTimeBestEffort('$max_ts') - INTERVAL ${FIRST_WINDOW_S:-3600} SECOND)")"
fi

if [ "$(val "SELECT parseDateTimeBestEffort('$from_ts') >= parseDateTimeBestEffort('$max_ts')")" = "1" ]; then
  echo "$(date -u +%FT%TZ) $DB nothing new (watermark $from_ts, max $max_ts)" >>"$LOG"
  exit 0
fi

t0=$(date +%s)
./scripts/ch.sh --param_tolerance_s="${TOLERANCE_S:-90}" --param_pause_inactive="${PAUSE_INACTIVE:-1}" \
  --param_from_ts="$from_ts" --param_to_ts="$max_ts" \
  --queries-file sql/pipeline/03_derive_incremental.sql
t1=$(date +%s)

# Post-tick invariants: the two that catch a broken tick immediately. Closure must hold,
# and no (session, minute) may be asserted twice.
closure="$(val "SELECT sum(delta) FROM concurrency_deltas")"
dupes="$(val "SELECT ifNull(max(s), 1) FROM (SELECT sum(sign) AS s FROM session_minute_runs GROUP BY video_session_id, run_start, run_end HAVING s > 0)")"
if [ "$closure" != "0" ] || [ "$dupes" != "1" ]; then
  echo "$(date -u +%FT%TZ) $DB TICK FAILED invariants: closure=$closure dupes=$dupes (window $from_ts -> $max_ts)" >>"$LOG"
  exit 1
fi

echo "$max_ts" >"$WM_FILE"
echo "$(date -u +%FT%TZ) $DB ok: window $from_ts -> $max_ts in $((t1 - t0))s, closure 0, dupes 1" >>"$LOG"
