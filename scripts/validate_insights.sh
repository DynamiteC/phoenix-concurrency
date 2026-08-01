#!/usr/bin/env bash
# Ground truth against the serving table, one insight at a time, zero diffs required.
#
#   ./scripts/validate_insights.sh                 # every insight
#   ./scripts/validate_insights.sh session_facts   # one
#
# WHY THE DIFF IS A SCRIPT AND NOT A <name>_diff.sql FILE, which is what the plan asks for. The
# two sides live in different engines on purpose: the ground truth runs in `clickhouse local`
# over the raw CSV, the optimized side runs on Cloud. No single SQL statement spans them, and
# making one would mean giving up the second engine, which is most of what the comparison is
# worth. scripts/parity.sh already made this trade for the concurrency oracle. Both SIDES are
# committed SQL; only the subtraction is bash.
#
# Missing and unexpected keys are reported separately from differing values, because "0 diff
# rows" hides the difference between a wrong number and an absent session.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/evidence.sh

DB="${CH_DATABASE:-phoenix_next}"
export CH_DATABASE="$DB" EVIDENCE_STAMP_DB="$DB"
CSV="${RAW_CSV:-data/ch-hackathon-raw-data.csv}"
ONLY="${1:-}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

fail_any=0

validate() {
  local name="$1"
  local gt="sql/insights/validation/${name}_ground_truth.sql"
  local op="sql/insights/validation/${name}_optimized.sql"
  [ -f "$gt" ] && [ -f "$op" ] || { echo "skip $name: missing one side of the pair" >&2; return 0; }

  echo "== $name: ground truth over $CSV in clickhouse local" >&2
  FORMAT=TSV ./scripts/oracle.sh "$CSV" "$gt" 2>/dev/null | LC_ALL=C sort > "$TMP/gt"

  echo "== $name: optimized over $DB" >&2
  ./scripts/ch.sh --format TSV --queries-file "$op" 2>/dev/null | LC_ALL=C sort > "$TMP/op"

  cut -f1 "$TMP/gt" > "$TMP/kgt"
  cut -f1 "$TMP/op" > "$TMP/kop"
  local missing unexpected differing gt_rows op_rows
  missing=$(comm -23 "$TMP/kgt" "$TMP/kop" | wc -l)
  unexpected=$(comm -13 "$TMP/kgt" "$TMP/kop" | wc -l)
  # Value differences on the keys BOTH sides carry, so a missing key is not also counted twice
  # as two differing rows.
  comm -12 "$TMP/kgt" "$TMP/kop" > "$TMP/common"
  LC_ALL=C join -t"$(printf '\t')" "$TMP/common" "$TMP/gt" > "$TMP/gtc"
  LC_ALL=C join -t"$(printf '\t')" "$TMP/common" "$TMP/op" > "$TMP/opc"
  differing=$(diff "$TMP/gtc" "$TMP/opc" | grep -c '^<' || true)
  gt_rows=$(wc -l < "$TMP/gt"); op_rows=$(wc -l < "$TMP/op")

  # ANTI-VACUOUS-PASS. Everything above reports zero when the comparison never happened: an
  # empty join, a key column that did not line up, a query that returned nothing. Zero diffs
  # over zero rows is the shape of a green check that checked nothing, and this repo has a file
  # listing eleven numbers that were plausible and unchecked. So the count of rows actually
  # compared is asserted against the count of keys both sides carry, and the pair is required to
  # be non-empty.
  local common compared columns
  common=$(wc -l < "$TMP/common")
  compared=$(wc -l < "$TMP/gtc")
  columns=$(head -1 "$TMP/gt" | awk -F'\t' '{print NF}')

  local verdict=PASS
  [ "$missing" = 0 ] && [ "$unexpected" = 0 ] && [ "$differing" = 0 ] || { verdict=FAIL; fail_any=1; }
  [ "$compared" = "$common" ] && [ "${compared:-0}" -gt 0 ] || { verdict=FAIL; fail_any=1; }
  [ "${columns:-0}" -gt 1 ] || { verdict=FAIL; fail_any=1; }

  {
    printf 'metric\tvalue\n'
    printf 'insight\t%s\n'                     "$name"
    printf 'database\t%s\n'                    "$DB"
    printf 'ground_truth_engine\tclickhouse local over %s\n' "$CSV"
    printf 'ground_truth_rows\t%s\n'           "$gt_rows"
    printf 'optimized_rows\t%s\t(frozen slice: sessions whose every event precedes frozen_before)\n' "$op_rows"
    printf 'differing_rows\t%s\t(required 0)\n'    "$differing"
    printf 'missing_keys\t%s\t(required 0)\n'      "$missing"
    printf 'unexpected_keys\t%s\t(required 0)\n'   "$unexpected"
    printf 'keys_in_common\t%s\n'                  "$common"
    printf 'rows_actually_compared\t%s\t(required equal to keys_in_common and greater than 0)\n' "$compared"
    printf 'columns_compared\t%s\t(required greater than 1)\n' "$columns"
    printf 'verdict\t%s\n' "$verdict"
    [ "$missing"    = 0 ] || comm -23 "$TMP/kgt" "$TMP/kop" | head -5 | sed 's/^/# missing: /'
    [ "$unexpected" = 0 ] || comm -13 "$TMP/kgt" "$TMP/kop" | head -5 | sed 's/^/# unexpected: /'
    [ "$differing"  = 0 ] || diff "$TMP/gtc" "$TMP/opc" | head -6 | sed 's/^/# diff: /'
  } | evidence "insight_parity_${name}" "${name}: independent ground truth in clickhouse local against the ${DB} serving table" \
    | xargs cat
}

if [ -n "$ONLY" ]; then
  validate "$ONLY"
else
  found=0
  for gt in sql/insights/validation/*_ground_truth.sql; do
    [ -e "$gt" ] || break
    found=1
    validate "$(basename "$gt" _ground_truth.sql)"
  done
  [ "$found" = 1 ] || echo "no insight validation pairs yet" >&2
fi

[ "$fail_any" = 0 ] || { echo "INSIGHT VALIDATION FAILED" >&2; exit 1; }
