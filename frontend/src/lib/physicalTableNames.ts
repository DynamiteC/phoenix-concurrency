// THE ONE LIST OF PHYSICAL TABLE AND MATERIALIZED-VIEW NAMES, shared by lib/sql.ts (v1 serving
// queries) and lib/insights.ts (v2 benchmark queries) so the unseen-day `unseen_` prefix is
// applied identically by both loaders instead of drifting into two copies.
//
// Sourced by grepping every `CREATE TABLE` / `CREATE MATERIALIZED VIEW` in sql/schema/*.sql and
// sql/insights/schema/*.sql. Keep this list in sync with those files if a table is added, renamed
// or dropped there.
//
// WHY WORD-BOUNDARY REGEX AND NOT A STRAIGHT STRING REPLACE. `raw_events` must not match inside
// `raw_events_landing` or `raw_events_mv`, and `content` must not match inside
// `content_entry_cohorts`. Underscore is a word character in regex, so `\braw_events\b` has no
// boundary to match at the point where `raw_events_landing` continues, and the two names are
// safe from each other regardless of which order this array lists them in.
//
// CHECKED AGAINST CTE ALIASES: sql/queries/serving/*.sql and sql/insights/benchmark/*.sql declare
// exactly two CTE names across the whole tree, `filtered` (most of the serving queries) and `ids`
// (title_category_peak_average.sql). Neither collides with a name below, so no query needs special
// handling here. If a future query introduces a CTE alias that happens to match one of these
// physical names, it will get silently rewritten too -- re-check this comment against
// sql/queries/serving/ and sql/insights/benchmark/ before adding a table name that could plausibly
// double as a short CTE alias (e.g. `content`, `runs`).
export const PHYSICAL_TABLE_NAMES: readonly string[] = [
  // sql/schema/*.sql -- the v1 concurrency engine
  'raw_events',
  'raw_events_landing',
  'raw_events_mv',
  'content',
  'foreground_intervals',
  'session_minute_runs',
  'concurrency_deltas',
  'concurrency_deltas_mv',
  'user_minute_runs',
  'user_concurrency_deltas',
  'user_concurrency_deltas_mv',
  'concurrency_boundary_deltas',
  'concurrency_boundary_deltas_mv',
  // sql/insights/schema/*.sql -- the v2 insight layer
  'session_insight_facts',
  'session_state_transitions',
  'audience_minute_snapshot',
  'content_entry_cohorts',
  'user_content_transitions',
  'user_platform_transitions',
  'playback_health_minute',
  'late_event_audit',
  'late_event_audit_mv',
  'concurrency_spike_events',
]

/**
 * Rewrites every known physical table/view name in `sql` to `${prefix}${name}`, so query text
 * written against the normal names also serves the unseen day's `unseen_`-prefixed tables without
 * a second copy of the SQL.
 *
 * A no-op when `prefix` is '': the original corpus's queries pass through unchanged, and this is
 * the only path either loader has ever executed until the unseen corpus needed one inside the
 * same database. The prefix itself is never client-supplied; see lib/datasets.server.ts.
 */
export function withTablePrefix(sql: string, prefix: string): string {
  if (!prefix) return sql
  return PHYSICAL_TABLE_NAMES.reduce(
    (text, name) => text.replace(new RegExp(`\\b${name}\\b`, 'g'), `${prefix}${name}`),
    sql,
  )
}
