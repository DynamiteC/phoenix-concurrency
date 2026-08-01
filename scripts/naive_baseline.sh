#!/usr/bin/env bash
# Build and measure the naive baseline table.
#
#   ./scripts/naive_baseline.sh
#
# concurrency_deltas_naive has the same structure and engine as concurrency_deltas, and is
# populated with the same minute-boundary rule, so the overcount is a table-vs-table
# comparison at identical grain rather than two numbers from two different implementations.
#
# The table is TRUNCATEd before every load. SummingMergeTree absorbs a second insert with no
# error and no complaint, so re-running without the truncate would silently double the naive
# curve and inflate the overcount.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/evidence.sh

DB="${CH_DATABASE:-phoenix}"
ch() { CH_DATABASE="$DB" ./scripts/ch.sh "$@" 2>/dev/null; }
val() { ch --format TSVRaw --query "$1" | head -1; }

echo "== 1. creating $DB.concurrency_deltas_naive from concurrency_deltas"
ch --query "CREATE TABLE IF NOT EXISTS concurrency_deltas_naive AS concurrency_deltas"
ch --query "TRUNCATE TABLE concurrency_deltas_naive"

echo "== 2. populating from raw_events (session span, first event to last)"
ch --queries-file sql/queries/validation/naive_deltas.sql

echo "== 3. assertions"
BAL=$(val "SELECT sum(delta) FROM concurrency_deltas_naive")
NMIN=$(val "SELECT min(minute) FROM concurrency_deltas_naive")
NMAX=$(val "SELECT max(minute) FROM concurrency_deltas_naive")
FMIN=$(val "SELECT min(minute) FROM concurrency_deltas")
FMAX=$(val "SELECT max(minute) FROM concurrency_deltas")
echo "   sum(delta) naive:     $BAL   (must be 0: every +1 has a matching -1)"
echo "   naive     span: $NMIN .. $NMAX"
echo "   corrected span: $FMIN .. $FMAX"

# A failed gate is evidence too. Exiting without writing one leaves the same hole this
# whole exercise exists to close: a result that lived only in a terminal.
gate_fail() {
  printf 'metric\tvalue\ngate\tFAIL\nreason\t%s\nnaive_sum_delta\t%s\nnaive_min_minute\t%s\nnaive_max_minute\t%s\ncorrected_min_minute\t%s\ncorrected_max_minute\t%s\n' \
    "$1" "$BAL" "$NMIN" "$NMAX" "$FMIN" "$FMAX" \
    | evidence naive_baseline_gate "range/balance gate before the naive-vs-corrected comparison" >/dev/null
  echo "FAIL: $1" >&2
  exit 1
}

[ "$BAL" = "0" ] || gate_fail "naive deltas do not balance to zero, the curve is not closed"
if [ "$NMIN" != "$FMIN" ] || [ "$NMAX" != "$FMAX" ]; then
  gate_fail "the two tables do not span the same range, the comparison would be invalid"
fi

echo "== 4. measuring"
# Both curves are densified to one row per minute across the shared range BEFORE any
# aggregate is taken. Deltas exist only at run boundaries, so a naive run covering minutes
# 10-20 has rows at 10 and 21 and nothing between. Counting phantom minutes on the sparse
# rows would find 1 where there are 11.
ch --format TSV --query "
WITH both AS
(
    SELECT minute, sum(dn) AS dn, sum(df) AS df
    FROM
    (
        SELECT minute, delta AS dn, 0 AS df FROM concurrency_deltas_naive
        UNION ALL
        SELECT minute, 0 AS dn, delta AS df FROM concurrency_deltas
    )
    GROUP BY minute
),
curves AS
(
    SELECT
        minute,
        toInt64(sum(dn) OVER w) AS naive,
        toInt64(sum(df) OVER w) AS corrected
    FROM both
    WINDOW w AS (ORDER BY minute ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ORDER BY minute ASC
    WITH FILL STEP toIntervalMinute(1) INTERPOLATE (naive AS naive, corrected AS corrected)
)
SELECT 'metric', 'value'
UNION ALL SELECT 'peak_naive',              toString(max(naive))                       FROM curves
UNION ALL SELECT 'peak_naive_minute',       toString(argMax(minute, naive))            FROM curves
UNION ALL SELECT 'peak_corrected',          toString(max(corrected))                   FROM curves
UNION ALL SELECT 'peak_corrected_minute',   toString(argMax(minute, corrected))        FROM curves
UNION ALL SELECT 'overcount_pct_at_peak',   toString(round((max(naive) - max(corrected)) * 100.0 / max(corrected), 1)) FROM curves
UNION ALL SELECT 'phantom_minutes',         toString(countIf(naive > 0 AND corrected = 0)) FROM curves
UNION ALL SELECT 'inverted_minutes',        toString(countIf(corrected > 0 AND naive = 0)) FROM curves
UNION ALL SELECT 'minutes_naive_gt0',       toString(countIf(naive > 0))               FROM curves
UNION ALL SELECT 'minutes_corrected_gt0',   toString(countIf(corrected > 0))           FROM curves
UNION ALL SELECT 'minutes_compared',        toString(count())                          FROM curves
UNION ALL SELECT 'range_start',             toString(min(minute))                      FROM curves
UNION ALL SELECT 'range_end',               toString(max(minute))                      FROM curves
UNION ALL SELECT 'naive_delta_rows',        toString((SELECT count() FROM concurrency_deltas_naive))
UNION ALL SELECT 'corrected_delta_rows',    toString((SELECT count() FROM concurrency_deltas))
UNION ALL SELECT 'naive_sum_delta',         toString((SELECT sum(delta) FROM concurrency_deltas_naive))
" | evidence naive_baseline "concurrency_deltas_naive vs concurrency_deltas, identical minute-boundary rule, densified" \
  | xargs cat
