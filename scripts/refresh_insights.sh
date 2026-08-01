#!/usr/bin/env bash
# Rebuild the insight layer for the sessions a window touched.
#
#   ./scripts/refresh_insights.sh                                   # full, wide window
#   FROM_TS='2026-07-26 00:00:00' TO_TS='2026-07-27 00:00:00' ./scripts/refresh_insights.sh
#   CH_DATABASE=phoenix_next ./scripts/refresh_insights.sh
#
# NO REFUSE-AND-REBUILD GUARD, and the contrast with scripts/derive.sh is the point rather than
# an oversight. derive.sh must refuse to run twice because 02_merge_runs.sql asserts sign = +1
# and APPENDS, so a second run doubles every run while closure stays 0 and
# max_runs_per_session_minute stays 1, meaning neither invariant notices. The insight tables are
# ReplacingMergeTree keyed on the session and every run stamps a higher version, so a second run
# SUPERSEDES. That is checked below rather than asserted in a comment: after the refresh, the
# number of distinct sessions must equal the number of rows under FINAL.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/evidence.sh

DB="${CH_DATABASE:-phoenix_next}"
export CH_DATABASE="$DB" EVIDENCE_STAMP_DB="$DB"
FROM_TS="${FROM_TS:-2000-01-01 00:00:00}"
TO_TS="${TO_TS:-2100-01-01 00:00:00}"
TOL="${TOLERANCE_S:-90}"

ch() { ./scripts/ch.sh "$@"; }
val() { ch --format TSVRaw --query "$1" 2>/dev/null | head -1; }

echo "== refreshing insights in $DB for events in [$FROM_TS, $TO_TS)" >&2
t0=$(date +%s)
for f in sql/insights/pipeline/*.sql; do
  [ -e "$f" ] || { echo "no insight pipeline files yet" >&2; exit 0; }
  echo "== $(basename "$f")" >&2
  ch --queries-file "$f" \
     --param_tolerance_s="$TOL" --param_from_ts="$FROM_TS" --param_to_ts="$TO_TS" 2>/dev/null
done
t1=$(date +%s)

rows_final=$(val "SELECT count() FROM session_insight_facts FINAL")
sessions=$(val   "SELECT uniqExact(video_session_id) FROM session_insight_facts")
rows_raw=$(val   "SELECT count() FROM session_insight_facts")
# Durations cannot be negative and active time cannot exceed the session's own span. Both are
# acceptance tests the plan names, and both are cheap enough to assert on every refresh.
neg=$(val "SELECT countIf(active_seconds < 0) FROM session_insight_facts FINAL")
over=$(val "SELECT countIf(active_seconds > dateDiff('second', session_start, last_event_at) + $TOL)
            FROM session_insight_facts FINAL")
dupes=$(val "SELECT max(n) FROM (SELECT count() AS n FROM session_insight_facts FINAL GROUP BY video_session_id)")

verdict=PASS
[ "$rows_final" = "$sessions" ] || verdict=FAIL
[ "${dupes:-9}" = "1" ]         || verdict=FAIL
[ "$neg"  = "0" ]               || verdict=FAIL
[ "$over" = "0" ]               || verdict=FAIL
[ "${sessions:-0}" -gt 0 ]      || verdict=FAIL

{
  printf 'metric\tvalue\n'
  printf 'database\t%s\n'          "$DB"
  printf 'window\t%s .. %s\n'      "$FROM_TS" "$TO_TS"
  printf 'refresh_seconds\t%s\n'   "$(( t1 - t0 ))"
  printf 'sessions\t%s\n'          "$sessions"
  printf 'rows_stored\t%s\t(versions, including superseded, before merges collapse them)\n' "$rows_raw"
  printf 'rows_under_final\t%s\t(required equal to sessions: this is what makes a re-run idempotent rather than additive)\n' "$rows_final"
  printf 'invariant.max_rows_per_session\t%s\t(required 1)\n'      "$dupes"
  printf 'invariant.negative_durations\t%s\t(required 0)\n'        "$neg"
  printf 'invariant.active_exceeds_session_span\t%s\t(required 0)\n' "$over"
  printf 'verdict\t%s\n' "$verdict"
} | evidence "refresh_insights_${DB}" "incremental insight refresh into ${DB}, with the post-conditions that catch an additive re-run" \
  | xargs cat

[ "$verdict" = PASS ] || { echo "INSIGHT REFRESH POST-CONDITIONS FAILED" >&2; exit 1; }
