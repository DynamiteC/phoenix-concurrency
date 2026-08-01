#!/usr/bin/env bash
# Evidence writer. Every script that produces a number calls this, so the number lands in a
# committed file stamped with when it ran, which code produced it, and WHICH DATA it saw.
#
#   . scripts/lib/evidence.sh
#   some_command | evidence parity_batch "oracle vs serving, batch path"
#
# Reads stdin, writes evidence/<name>__<UTC-ts>__<sha>.tsv, echoes the path on stdout and
# stderr (stderr so a caller that captures the path still shows it in the console).
#
# The sha carries a -dirty suffix when the tree has uncommitted changes: an artifact that
# claims a clean sha but came from uncommitted code is exactly the failure this repo is
# fixing. --porcelain, not `diff --quiet`: an untracked script is uncommitted code too.
#
# The data stamp exists because a git sha pins the CODE and says nothing about the DATA. The
# team ingests into phoenix.raw_events continuously, so an artifact without a row count is
# not reproducible: re-running it tomorrow measures a different dataset and the numbers move
# with no indication that anything changed.
#
# Set EVIDENCE_DB=0 to skip the data stamp (offline runs, clickhouse-local-only scripts).

# Queried once per shell, not once per artifact: a script writing four artifacts should not
# make four round trips, and the four should agree with each other.
_EV_DATA_STAMP=""
_ev_data_stamp() {
  [ -n "$_EV_DATA_STAMP" ] && { printf '%s' "$_EV_DATA_STAMP"; return; }
  [ "${EVIDENCE_DB:-1}" = "0" ] && { _EV_DATA_STAMP="# data: not queried (EVIDENCE_DB=0)
"; printf '%s' "$_EV_DATA_STAMP"; return; }

  local row
  row="$(CH_DATABASE=phoenix ./scripts/ch.sh --format TSVRaw --query "
    SELECT count(),
           toString(max(event_timestamp)),
           toString(max(ingested_at)),
           countIf(toYYYYMMDD(event_timestamp) < 20260801)
    FROM raw_events" 2>/dev/null | head -1)" || true

  if [ -z "$row" ]; then
    _EV_DATA_STAMP="# data: UNAVAILABLE (could not reach the service)
"
  else
    _EV_DATA_STAMP="# row_count: $(echo "$row" | cut -f1)
# event_watermark: $(echo "$row" | cut -f2)
# frozen_slice_rows: $(echo "$row" | cut -f4)   (event_timestamp before 2026-08-01, the validated July replay)
# ingest_watermark: $(echo "$row" | cut -f3)   (NOT REPRODUCIBLE, see below)
# ingest_watermark_warning: ingested_at was added by ALTER after the July rows were loaded.
#   ClickHouse does not rewrite existing parts, so for those 905,558 rows the DEFAULT now()
#   is evaluated AT READ TIME and the column equals the wall clock of whichever query reads
#   it. Proven in evidence/ingested_at_nondeterminism. Do not filter on it.
"
  fi
  printf '%s' "$_EV_DATA_STAMP"
}

evidence() {
  local name="$1" desc="${2:-}"
  local ts sha out
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  [ -z "$(git status --porcelain 2>/dev/null)" ] || sha="${sha}-dirty"
  out="evidence/${name}__${ts}__${sha}.tsv"
  mkdir -p evidence
  {
    echo "# evidence: ${name}"
    [ -n "$desc" ] && echo "# what: ${desc}"
    echo "# run_utc: $(date -u +'%Y-%m-%d %H:%M:%S')"
    echo "# git: ${sha}"
    echo "# host: $(uname -n)"
    _ev_data_stamp
    cat
  } > "$out"
  echo "wrote $out" >&2
  echo "$out"
}
