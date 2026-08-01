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

# select_sequential_consistency=1 everywhere in this script: on Cloud SharedMergeTree a
# SELECT can land on a replica that has not yet seen the last insert, so a retract that
# reads stale state MISSES freshly asserted runs and the next assert duplicates them.
# Measured live 2026-08-01 18:51: two byte-identical +1 rows from consecutive passes.
CHT() { ./scripts/ch.sh --select_sequential_consistency=1 "$@"; }
val() { CHT --format TSVRaw --query "$1" 2>/dev/null | head -1; }

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
# Up to two passes. A session whose first in-window event arrives BETWEEN the retract and
# the assert gets asserted without being retracted; if a late content row also flipped its
# dims, two variants of the same run are briefly live and the dupes invariant trips.
# Measured live 2026-08-01 18:45: exactly this signature, healed by one retry, because the
# retract emits sum(sign) retractions per group and zeroes any accumulated state. So one
# in-tick retry absorbs the known-transient race; a failure that survives it is real.
for attempt in 1 2; do
  CHT --param_tolerance_s="${TOLERANCE_S:-90}" --param_pause_inactive="${PAUSE_INACTIVE:-1}" \
    --param_from_ts="$from_ts" --param_to_ts="$max_ts" \
    --queries-file sql/pipeline/03b_derive_incremental_atomic.sql
  closure="$(val "SELECT sum(delta) FROM concurrency_deltas")"
  dupes="$(val "SELECT ifNull(max(s), 1) FROM (SELECT sum(sign) AS s FROM session_minute_runs GROUP BY video_session_id, run_start, run_end HAVING s > 0)")"
  negs="$(val "SELECT countIf(s < 0) FROM (SELECT sum(sign) AS s FROM session_minute_runs GROUP BY video_session_id, run_start, run_end)")"
  [ "$closure" = "0" ] && [ "$dupes" = "1" ] && [ "$negs" = "0" ] && break
  echo "$(date -u +%FT%TZ) $DB attempt $attempt tripped invariants: closure=$closure dupes=$dupes, retrying same window" >>"$LOG"
done
# Healing pass. The dupes check is GLOBAL but the retract only reaches sessions with
# events in the current window, so a double whose session has gone quiet is out of every
# future window and would fail every tick forever. When dupes persist, derive the
# offending sessions' own event range: that puts them in the touched-set, the exact
# retract zeroes them, and the assert writes the one correct variant.
if [ "$dupes" != "1" ] || [ "$negs" != "0" ]; then
  heal_range="$(val "SELECT concat(toString(min(event_timestamp)), '|', toString(max(event_timestamp) + INTERVAL 1 SECOND))
    FROM raw_events WHERE video_session_id IN (
      SELECT video_session_id FROM session_minute_runs
      GROUP BY video_session_id, run_start, run_end HAVING sum(sign) > 1 OR sum(sign) < 0)")"
  heal_from="${heal_range%%|*}"; heal_to="${heal_range##*|}"
  echo "$(date -u +%FT%TZ) $DB healing pass over offender range $heal_from -> $heal_to" >>"$LOG"
  CHT --param_tolerance_s="${TOLERANCE_S:-90}" --param_pause_inactive="${PAUSE_INACTIVE:-1}" \
    --param_from_ts="$heal_from" --param_to_ts="$heal_to" \
    --queries-file sql/pipeline/03b_derive_incremental_atomic.sql
  closure="$(val "SELECT sum(delta) FROM concurrency_deltas")"
  dupes="$(val "SELECT ifNull(max(s), 1) FROM (SELECT sum(sign) AS s FROM session_minute_runs GROUP BY video_session_id, run_start, run_end HAVING s > 0)")"
  negs="$(val "SELECT countIf(s < 0) FROM (SELECT sum(sign) AS s FROM session_minute_runs GROUP BY video_session_id, run_start, run_end)")"
fi

# USER STAGE. The session stage above only writes session_minute_runs; user_minute_runs is a
# separate rebuild (04) that this tick never ran, so the Users side of the console stayed at
# whatever the last batch derive left and read zero for every live minute. 04c is the windowed,
# self-healing twin of 04, scoped to users touched in this window: see that file for why the
# scope is required and not just an optimisation. Runs only after the session invariants hold,
# since it reads asserted session runs.
if [ "$closure" = "0" ] && [ "$dupes" = "1" ] && [ "$negs" = "0" ]; then
  CHT --param_from_ts="$from_ts" --param_to_ts="$max_ts" \
    --queries-file sql/pipeline/04c_merge_user_runs_atomic.sql
  uclosure="$(val "SELECT sum(delta) FROM user_concurrency_deltas")"
  udupes="$(val "SELECT ifNull(max(s), 1) FROM (SELECT sum(sign) AS s FROM user_minute_runs GROUP BY user_id, run_start, run_end HAVING s > 0)")"
  if [ "$uclosure" != "0" ] || [ "$udupes" != "1" ]; then
    echo "$(date -u +%FT%TZ) $DB USER STAGE FAILED: closure=$uclosure dupes=$udupes" >>"$LOG"
    exit 1
  fi
fi
t1=$(date +%s)

if [ "$closure" != "0" ] || [ "$dupes" != "1" ] || [ "$negs" != "0" ]; then
  echo "$(date -u +%FT%TZ) $DB TICK FAILED invariants after retry and healing pass: closure=$closure dupes=$dupes negatives=$negs (window $from_ts -> $max_ts)" >>"$LOG"
  exit 1
fi

echo "$max_ts" >"$WM_FILE"
echo "$(date -u +%FT%TZ) $DB ok: window $from_ts -> $max_ts in $((t1 - t0))s, closure 0, dupes 1, negatives 0" >>"$LOG"
