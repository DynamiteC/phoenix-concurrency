#!/usr/bin/env bash
# THE ONE PLACE the shell side keeps the list of physical table/view names, so init_db.sh,
# init_insights.sh, derive.sh, refresh_insights.sh and load.sh rewrite the same names when
# TABLE_PREFIX is set. Mirrors frontend/src/lib/physicalTableNames.ts on the TypeScript side; keep
# both lists in sync if a table is added, renamed or dropped in sql/schema/*.sql or
# sql/insights/schema/*.sql.
#
# Sourced, not executed: `. scripts/prefix_sql.sh` from a script that has already done
# `cd "$(dirname "$0")/.."`, so the array and functions below land in the caller's shell.
#
# WHY \< and \> (GNU sed word-boundary anchors) rather than a plain substitution: `raw_events`
# must not match inside `raw_events_landing` or `raw_events_mv`, and `content` must not match
# inside `content_entry_cohorts`. Underscore is a word character, so there is no boundary at the
# point where the longer name continues, and these anchors give the same protection lib/sql.ts's
# `\b` gets on the TypeScript side.
PHYSICAL_TABLE_NAMES=(
  raw_events raw_events_landing raw_events_mv
  content
  foreground_intervals session_minute_runs
  concurrency_deltas concurrency_deltas_mv
  user_minute_runs user_concurrency_deltas user_concurrency_deltas_mv
  concurrency_boundary_deltas concurrency_boundary_deltas_mv
  session_insight_facts session_state_transitions audience_minute_snapshot
  content_entry_cohorts user_content_transitions user_platform_transitions
  playback_health_minute late_event_audit late_event_audit_mv
  concurrency_spike_events
)

# Temp files created by prefixed_sql_file, cleaned up by cleanup_prefixed_sql_files. A caller adds
#   trap cleanup_prefixed_sql_files EXIT
# once, near the top, after sourcing this file.
_PREFIX_SQL_TMP_FILES=()

# Rewrites the known physical names in a literal SQL string (e.g. the inline queries derive.sh and
# refresh_insights.sh build with val()). Prints the rewritten text; a no-op when TABLE_PREFIX is
# unset or empty.
prefix_sql_text() {
  local text="$1" prefix="${TABLE_PREFIX:-}"
  if [ -z "$prefix" ]; then
    printf '%s' "$text"
    return
  fi
  local sed_args=()
  local name
  for name in "${PHYSICAL_TABLE_NAMES[@]}"; do
    sed_args+=(-e "s/\<${name}\>/${prefix}${name}/g")
  done
  printf '%s' "$text" | sed "${sed_args[@]}"
}

# Rewrites the known physical names in a SQL FILE and prints the path to read instead of the
# original: the original when TABLE_PREFIX is unset/empty (nothing to clean up), otherwise a new
# temp file registered for cleanup_prefixed_sql_files.
#
#   pf="$(prefixed_sql_file sql/schema/01_raw_events.sql)"
#   ./scripts/ch.sh --queries-file "$pf"
prefixed_sql_file() {
  local src="$1" prefix="${TABLE_PREFIX:-}"
  if [ -z "$prefix" ]; then
    printf '%s' "$src"
    return
  fi
  local sed_args=()
  local name
  for name in "${PHYSICAL_TABLE_NAMES[@]}"; do
    sed_args+=(-e "s/\<${name}\>/${prefix}${name}/g")
  done
  local tmp
  tmp="$(mktemp)"
  sed "${sed_args[@]}" "$src" > "$tmp"
  _PREFIX_SQL_TMP_FILES+=("$tmp")
  printf '%s' "$tmp"
}

cleanup_prefixed_sql_files() {
  local f
  for f in "${_PREFIX_SQL_TMP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f "$f"
  done
}
