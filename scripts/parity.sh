#!/usr/bin/env bash
# Oracle parity gate. Proves the serving layer answers what brute force answers, on both
# derivation paths, and writes the result to evidence/ instead of a terminal nobody kept.
#
#   ./scripts/parity.sh [csv]
#
# Two comparisons, both against the SAME oracle run:
#   batch        phoenix.concurrency_deltas, derived by 01 + 02
#   incremental  a scratch database derived only by 03, over the whole span
#
# The oracle runs in `clickhouse local` over the CSV; the serving layer runs on Cloud. That
# is deliberate: two engines, two independent implementations of the state machine, same
# parameters. Both wrappers pin session_timezone=UTC.
#
# Nothing here writes to `phoenix`. 02_merge_runs.sql asserts sign=+1 unconditionally, so
# re-running the batch path against the validated database would append duplicate runs that
# SummingMergeTree absorbs silently. Batch parity therefore reads phoenix as it stands.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/evidence.sh

CSV="${1:-data/ch-hackathon-raw-data.csv}"
TOL="${TOLERANCE_S:-90}"
PI="${PAUSE_INACTIVE:-1}"
INCR_DB=phoenix_parity_incr
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ch() { ./scripts/ch.sh "$@" 2>/dev/null; }
FULL=(--param_platform='' --param_country='' --param_video_type='' --param_app_version=''
      --param_content_id=0 --param_from_ts='2000-01-01 00:00:00' --param_to_ts='2100-01-01 00:00:00')

echo "== 1. oracle over $CSV (tolerance_s=$TOL pause_inactive=$PI)"
FORMAT=TSV TOLERANCE_S="$TOL" PAUSE_INACTIVE="$PI" \
  ./scripts/oracle.sh "$CSV" sql/queries/validation/oracle_concurrency.sql 2>/dev/null \
  | sort > "$TMP/oracle.tsv"
cut -f1,2 "$TMP/oracle.tsv" > "$TMP/oracle_sessions.tsv"
cut -f1,3 "$TMP/oracle.tsv" > "$TMP/oracle_users.tsv"
echo "   oracle minutes: $(wc -l < "$TMP/oracle.tsv")"

# The oracle emits only minutes that had an audience. concurrency.sql densifies with
# WITH FILL, so its zero rows have no oracle counterpart by construction; comparing them
# would manufacture diffs that are an artifact of densification, not a disagreement.
served() { CH_DATABASE="$1" ch --format TSV "${FULL[@]}" --queries-file "$2" \
             | awk -F'\t' '$2 > 0 {print $1 "\t" $2}' | sort; }

echo "== 2. batch path: phoenix serving layer vs oracle"
served phoenix sql/queries/benchmark/concurrency.sql      > "$TMP/batch_sessions.tsv"
served phoenix sql/queries/benchmark/user_concurrency.sql > "$TMP/batch_users.tsv"

echo "== 3. incremental path: $INCR_DB, derived only by 03 over the whole span"
ch --query "DROP DATABASE IF EXISTS $INCR_DB"
ch --query "CREATE DATABASE $INCR_DB"
for f in sql/schema/*.sql; do CH_DATABASE="$INCR_DB" ch --queries-file "$f"; done
CH_DATABASE="$INCR_DB" ch --query "INSERT INTO content SELECT * FROM phoenix.content"
CH_DATABASE="$INCR_DB" ch --query "INSERT INTO raw_events SELECT * FROM phoenix.raw_events"
CH_DATABASE="$INCR_DB" ch --param_tolerance_s="$TOL" --param_pause_inactive="$PI" \
  --param_from_ts='2000-01-01 00:00:00' --param_to_ts='2100-01-01 00:00:00' \
  --queries-file sql/pipeline/03_derive_incremental.sql
CH_DATABASE="$INCR_DB" ch --queries-file sql/pipeline/04_merge_user_runs.sql
served "$INCR_DB" sql/queries/benchmark/concurrency.sql      > "$TMP/incr_sessions.tsv"
served "$INCR_DB" sql/queries/benchmark/user_concurrency.sql > "$TMP/incr_users.tsv"

echo "== 4. diffs"
{
  printf 'comparison\tpath\toracle_minutes\tserved_minutes\tdiff_rows\tverdict\n'
  fail=0
  for c in "sessions batch $TMP/oracle_sessions.tsv $TMP/batch_sessions.tsv" \
           "users batch $TMP/oracle_users.tsv $TMP/batch_users.tsv" \
           "sessions incremental $TMP/oracle_sessions.tsv $TMP/incr_sessions.tsv" \
           "users incremental $TMP/oracle_users.tsv $TMP/incr_users.tsv"; do
    set -- $c
    d=$(diff "$3" "$4" | grep -c '^[<>]' || true)
    [ "$d" = 0 ] || fail=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$(wc -l < "$3")" "$(wc -l < "$4")" "$d" \
      "$([ "$d" = 0 ] && echo PASS || echo FAIL)"
    [ "$d" = 0 ] || diff "$3" "$4" | head -10 | sed 's/^/# diff: /' >&2
  done
  printf '#\tcsv\t%s\n#\ttolerance_s\t%s\n#\tpause_inactive\t%s\n' "$CSV" "$TOL" "$PI"
  echo "$fail" > "$TMP/fail"
} | evidence oracle_parity "oracle (clickhouse local, CSV) vs serving layer, batch and incremental" | xargs cat

[ "$(cat "$TMP/fail")" = 0 ] || { echo "PARITY FAILED" >&2; exit 1; }
echo "PARITY PASS"
