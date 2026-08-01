# SonyLIV Concurrent User Flow Insights — Phase-wise ClickHouse Change Plan

> **Audience:** Database / backend engineer implementing additional SonyLIV audience-flow insights.
>
> **Current database:** `phoenix`
>
> **Goal:** Extend the existing foreground-only concurrency pipeline into an audience intelligence layer without breaking the already validated concurrency engine.
>
> **Important:** Do not modify the validated `event_state` logic unless the team explicitly approves a business-rule change. Build new insight tables downstream from the existing runs and serving layers wherever possible.

---



# Mandatory Evaluation Framework

Every phase in this plan must pass **both** of the following gates before it is considered complete.

## Gate A — Correctness Against Ground Truth

The benchmark answer must match an independently derived reference result.

The private judge will not accept an answer merely because:

- the SQL looks reasonable,
- the chart looks plausible,
- the query is fast,
- the aggregate is internally consistent,
- or the result is close.

For every metric, create a slow, obviously correct reference query from raw events or normalized state transitions and compare it with the optimized serving query.

### Correctness principles

1. **Foreground-only means foreground-only.**

   Do not count time when the application or player is:

   - backgrounded,
   - explicitly paused,
   - ended,
   - in an unrecovered error state,
   - or beyond the heartbeat tolerance.

2. **Background overcounting is a blocking failure.**

   A query that is fast but includes backgrounded minutes fails the core problem.

3. **Use event time, not arrival order.**

   Out-of-order ingestion must produce the same final answer as correctly ordered ingestion.

4. **Duplicate events must not change results.**

   Replaying the same event batch must leave all final insight values unchanged.

5. **Open sessions must be revisable.**

   A new heartbeat, background event, session-end event, or late correction must update only the affected sessions and minutes while preserving the same result as a one-pass batch computation.

6. **Dense time windows are mandatory for averages.**

   Average concurrency must include every minute in the requested range according to the documented definition, including minutes without a delta row.

7. **Session concurrency and user concurrency must remain separate.**

   Infrastructure load is measured by active sessions; audience reach is measured by unique active users.

### Required correctness artifacts per insight

For every new insight, commit:

```text
sql/insights/validation/<insight_name>_ground_truth.sql
sql/insights/validation/<insight_name>_optimized.sql
sql/insights/validation/<insight_name>_diff.sql
evidence/<insight_name>_parity_<timestamp>.tsv
```

The diff query must return:

```text
0 differing rows
0 missing keys
0 unexpected keys
```

Where floating-point metrics are used, define an explicit tolerance and explain it.

### Mandatory correctness dimensions

Every benchmark must be tested:

- unfiltered,
- by platform,
- by country,
- by content,
- by video type,
- by app version,
- and with at least one multi-dimension combination.

### Mandatory correctness scenarios

Each insight must be validated against:

- normal play,
- app background and return,
- pause and resume,
- missing heartbeat,
- video error,
- duplicate events,
- out-of-order events,
- late background event,
- late session end,
- open session receiving a new heartbeat,
- same user on multiple devices,
- content switch,
- cross-minute boundary,
- cross-day boundary,
- empty minute ranges,
- and a filter combination with no matching rows.

---

## Gate B — Query Performance and Read Efficiency

Judges will inspect what each query reads, not only elapsed time.

A query that returns in 20 ms by scanning all raw events is not considered a good serving design.

### Performance principles

1. Dashboard and benchmark queries must read the smallest suitable serving table.
2. They must not reconstruct all session state from `raw_events`.
3. Latency must be recorded together with:
   - `read_rows`,
   - `read_bytes`,
   - `result_rows`,
   - memory usage,
   - table list,
   - and query plan.
4. Filters should prune data where the physical design claims they do.
5. Query performance must be measured at the provided volume and projected at 10x and 100x.
6. Fast execution caused only by a tiny cache or tiny dataset must not be presented as proof of scalability.

### Required performance artifacts per insight

Commit:

```text
sql/insights/benchmark/<insight_name>.sql
sql/insights/benchmark/<insight_name>_explain.sql
evidence/<insight_name>_query_log_<timestamp>.tsv
```

Capture from `system.query_log`:

```sql
SELECT
    query_id,
    query_duration_ms,
    read_rows,
    read_bytes,
    result_rows,
    memory_usage,
    tables,
    query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_id = '<query_id>';
```

Also capture:

```sql
EXPLAIN indexes = 1
SELECT ...;
```

and where useful:

```sql
EXPLAIN PIPELINE
SELECT ...;
```

### Performance pass conditions

A phase passes only when:

- the query reads an approved serving or aggregate table,
- `raw_events` is absent from the benchmark query plan,
- rows and bytes read are within the documented budget,
- common filters do not increase reads unexpectedly,
- and performance remains stable across repeated runs.

---

# Phase Completion Template

Every phase below must include this record:

| Field | Required evidence |
|---|---|
| Business metric definition | Written definition |
| Ground-truth query | Slow independent SQL |
| Optimized query | Serving-layer SQL |
| Parity result | Zero-diff artifact |
| Edge scenarios | Scenario test artifact |
| Query duration | `system.query_log` |
| Rows read | `system.query_log` |
| Bytes read | `system.query_log` |
| Tables read | `system.query_log` |
| Index pruning | `EXPLAIN indexes = 1` |
| 10x/100x assessment | Written estimate |
| Final status | PASS / FAIL / PARTIAL |

A phase is **FAIL** when either correctness or performance fails.


# 1. Current Architecture

```text
raw_events_landing
  -> raw_events_mv
  -> raw_events
  -> event_state
  -> foreground_intervals
  -> session_minute_runs
  -> concurrency_deltas
  -> dashboard
```

User-level path:

```text
session_minute_runs
  -> user_minute_runs
  -> user_concurrency_deltas
```

## Existing strengths to reuse

- Millisecond raw event timestamps.
- Normalized foreground/background/pause/resume/error/heartbeat state.
- Separate session and unique-user concurrency.
- Retract-and-reassert correction model for open and late sessions.
- Compact dashboard serving tables.
- Content metadata in `content`.
- Existing filters: platform, country, video type, content ID, and app version.

## Existing limitations

- `title` and `category` are not in the serving table.
- Current `ingested_at DEFAULT now()` is not trustworthy for historical arrival-time analysis.
- No lateness boundary or quarantine path.
- No ClickStack, Langfuse, or LibreChat integration.
- The demo still uses old average queries.
- No TTL/retention policy.
- Notification, advertisement, campaign, sports-moment, ISP and CDN events are absent.

---

# 2. Insight Feasibility Matrix

| Insight | Existing data sufficient? | DB work required? | New upstream event required? |
|---|---:|---:|---:|
| Live spike decomposition | Yes | Yes | No |
| Spike sustainability | Yes | Yes | No |
| Foreground/background flow | Yes | Yes | No |
| Return after background | Yes | Yes | No |
| Session vs unique-user concurrency | Already available | Minor query work | No |
| Platform/country retention | Yes | Yes | No |
| App-version health | Yes | Yes | No |
| Video-error/heartbeat impact | Yes | Yes | No |
| Content switching | Mostly | Yes | No |
| Platform migration | Mostly | Yes | No |
| Early vs late joiner retention | Yes | Yes | No |
| Break-time behavior | Partial | Yes | Sports markers recommended |
| Sports moment impact | Partial/inferred | Yes | Timeline event recommended |
| Notification effectiveness | No | Yes | Yes |
| Advertisement impact | No | Yes | Yes |
| ISP/CDN quality | No | Yes | Yes |
| Campaign attribution | No | Yes | Yes |
| Basic peak forecasting | Yes | Yes | No |
| ClickStack operational insight | Yes | Yes | No |

---

# 3. Implementation Principles

1. Keep the existing concurrency engine unchanged.
2. New insight tables should read from `raw_events`, `event_state`, `session_minute_runs FINAL`, `user_minute_runs FINAL`, and the delta tables.
3. Do not calculate all advanced insights directly in dashboard queries.
4. Persist reusable session facts and transitions.
5. Use event time for behavior; use an explicitly written arrival time for lateness.
6. Keep session and unique-user metrics separate.
7. Use versioned or retractable models so late events can correct prior output.
8. Prefer a separate database or namespace such as `phoenix_insights`.

Recommended layers:

```text
Raw events
  -> Session facts
  -> State and user transitions
  -> Minute aggregates
  -> Spike/cohort/health serving tables
  -> Dashboard, ClickStack and AI summaries
```

---

# 4. Phase 0 — Mandatory Fixes

## 4.1 Wire corrected average queries

Update `demo/server.js` to read the corrected files from:

```text
sql/queries/serving/
```

and stop loading the old files from:

```text
sql/queries/benchmark/
```

### Acceptance criteria

- Full-day denominator is exactly 1,440 minutes.
- Standing concurrency is carried forward over minutes without delta rows.
- Leading and trailing empty minutes are included.
- Windows beginning during an active session are seeded correctly.
- The demo returns the independently validated dense average.

## 4.2 Decide session-end behavior

Dirty data includes events after `VideoSessionEnd`. Choose and document one rule:

### Option A — First end is terminal

Ignore later events using the same `video_session_id`.

### Option B — Reopening is valid

A later `VideoPlay` starts another logical playback instance.

### Recommendation

Choose Option A unless SonyLIV's event contract explicitly allows reuse. If reuse is valid, derive:

```text
playback_instance_no UInt16
```

and key new session facts by `(video_session_id, playback_instance_no)`.

## 4.3 Add trustworthy arrival time

Add to landing and raw ingestion:

```sql
arrival_timestamp DateTime64(3)
```

It must be explicitly supplied by the producer/load script. Do not rely on a historical `DEFAULT now()` column.

## 4.4 Add lateness policy and audit table

Document:

```text
allowed_lateness_seconds
finalization_delay_seconds
very_late_event_action
```

Create:

```sql
CREATE TABLE phoenix_insights.late_event_audit
(
    event_date Date,
    video_session_id String,
    event_timestamp DateTime64(3),
    arrival_timestamp DateTime64(3),
    lateness_seconds Int64,
    lateness_class LowCardinality(String),
    event_type LowCardinality(String),
    event LowCardinality(String),
    recorded_at DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY event_date
ORDER BY (lateness_class, event_date, video_session_id, event_timestamp);
```

Suggested classes:

```text
on_time
late_acceptable
late_after_finalization
invalid_future_event
```

---

# 5. Phase 1 — Core Session Insight Facts

## Objective

Create one reusable row per logical playback session/instance.

## New table: `session_insight_facts`

```sql
CREATE TABLE phoenix_insights.session_insight_facts
(
    video_session_id String,
    playback_instance_no UInt16,
    user_id String,
    content_id Int64,

    title String,
    category LowCardinality(String),
    video_type LowCardinality(String),
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),

    session_start DateTime64(3),
    first_play_at Nullable(DateTime64(3)),
    first_active_at Nullable(DateTime64(3)),
    last_active_at Nullable(DateTime64(3)),
    session_end_at Nullable(DateTime64(3)),

    active_seconds UInt32,
    foreground_seconds UInt32,
    background_seconds UInt32,
    paused_seconds UInt32,
    heartbeat_gap_seconds UInt32,

    active_interval_count UInt16,
    background_count UInt16,
    foreground_return_count UInt16,
    pause_count UInt16,
    resume_count UInt16,
    heartbeat_count UInt32,
    video_error_count UInt16,

    reached_first_heartbeat UInt8,
    active_after_1m UInt8,
    active_after_5m UInt8,
    active_after_10m UInt8,
    active_after_15m UInt8,

    ended_normally UInt8,
    timed_out UInt8,
    abandoned UInt8,
    reopened_after_end UInt8,

    first_event_at DateTime64(3),
    last_event_at DateTime64(3),
    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(session_start)
ORDER BY (content_id, session_start, platform, country, video_session_id, playback_instance_no);
```

## Why required

This table supports:

- session duration and survival,
- background/return rates,
- pause/resume rates,
- timeout and abandonment,
- video-error impact,
- platform/country/app-version retention,
- early and late joiner comparisons.

## Derivation source

Use:

```text
raw_events
 event_state
 session_minute_runs FINAL
 content
```

Use event-level timestamps for duration, not only minute runs.

## Refresh method

For each arrival batch:

1. Identify touched `video_session_id` values.
2. Rebuild facts only for touched sessions.
3. Insert a higher `version`.
4. Never rebuild all history for every heartbeat.

## Acceptance tests

- One row per logical playback instance.
- All durations non-negative.
- `active_seconds` cannot exceed total session duration.
- Duplicate source events do not change results.
- Late background/end events update the row.
- Re-running the same batch does not double metrics.

---

# 6. Phase 2 — Session State Transitions

## New table: `session_state_transitions`

```sql
CREATE TABLE phoenix_insights.session_state_transitions
(
    video_session_id String,
    playback_instance_no UInt16,
    user_id String,
    content_id Int64,
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),
    video_type LowCardinality(String),

    transition_at DateTime64(3),
    from_state LowCardinality(String),
    to_state LowCardinality(String),
    trigger_event_type LowCardinality(String),
    trigger_event LowCardinality(String),
    seconds_in_previous_state UInt32,
    transition_sequence UInt32,

    version UInt64,
    sign Int8
)
ENGINE = CollapsingMergeTree(sign)
PARTITION BY toYYYYMM(transition_at)
ORDER BY (video_session_id, playback_instance_no, transition_at, transition_sequence);
```

## Standard states

```text
created
playing_foreground
paused_foreground
background
stale_heartbeat
error
ended
```

## Insights enabled

- background-entry rate,
- return-to-foreground rate,
- average background duration,
- pause/resume behavior,
- recovery after error,
- heartbeat-timeout exits,
- user-flow Sankey chart,
- behavior during breaks.

---

# 7. Phase 3 — Audience Minute Snapshot

## Objective

Add an insight-friendly dense minute table while keeping `concurrency_deltas` as the authoritative concurrency source.

## New table: `audience_minute_snapshot`

```sql
CREATE TABLE phoenix_insights.audience_minute_snapshot
(
    minute DateTime,
    content_id Int64,
    title String,
    category LowCardinality(String),
    video_type LowCardinality(String),
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),

    concurrent_sessions UInt32,
    concurrent_users UInt32,
    session_starts UInt32,
    first_plays UInt32,
    foreground_entries UInt32,
    background_entries UInt32,
    foreground_returns UInt32,
    session_ends UInt32,
    video_errors UInt32,
    heartbeat_timeouts UInt32,
    active_seconds UInt64,
    background_seconds UInt64,

    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(minute)
ORDER BY (minute, content_id, platform, country, video_type, app_version);
```

## Why `ReplacingMergeTree`

Each minute/dimension row is a complete current snapshot. Late events can insert a newer version without mutation.

## Keep both layers

```text
concurrency_deltas
  = compact authoritative concurrency engine

audience_minute_snapshot
  = behavior and dashboard insight layer
```

---

# 8. Phase 4 — Spike Detection and Explanation

## New table: `concurrency_spike_events`

```sql
CREATE TABLE phoenix_insights.concurrency_spike_events
(
    spike_id UUID,
    detected_at DateTime,
    window_start DateTime,
    window_end DateTime,
    peak_minute DateTime,

    content_id Int64,
    title String,
    category LowCardinality(String),
    video_type LowCardinality(String),

    baseline_concurrency UInt32,
    peak_concurrency UInt32,
    absolute_growth Int32,
    growth_percent Float32,
    minutes_to_peak UInt16,
    minutes_above_80pct_peak UInt16,

    concurrency_after_5m UInt32,
    concurrency_after_10m UInt32,
    retention_5m_percent Float32,
    retention_10m_percent Float32,

    top_platform LowCardinality(String),
    top_platform_contribution UInt32,
    top_country LowCardinality(String),
    top_country_contribution UInt32,
    top_app_version LowCardinality(String),
    top_app_version_contribution UInt32,

    background_rate_after_peak Float32,
    error_rate_after_peak Float32,
    timeout_rate_after_peak Float32,

    spike_type LowCardinality(String),
    confidence Float32,
    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(peak_minute)
ORDER BY (content_id, peak_minute, spike_id);
```

## Initial spike rule

```text
growth_percent >= 20%
AND absolute_growth >= configurable minimum
AND growth occurs within 5 minutes
```

## Suggested spike types

```text
healthy_sustained
short_lived
technical_recovery
content_switch
unknown
```

## Example generated insight

```text
Concurrency increased 42% within four minutes.
ANDROID_PHONE produced 68% of the growth.
Audience remained above 80% of peak for 12 minutes.
Error rate remained below 0.4%, indicating a healthy spike.
```

---

# 9. Phase 5 — Entry Cohorts and Retention

## New table: `content_entry_cohorts`

```sql
CREATE TABLE phoenix_insights.content_entry_cohorts
(
    cohort_minute DateTime,
    content_id Int64,
    title String,
    category LowCardinality(String),
    video_type LowCardinality(String),
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),

    entered_sessions UInt32,
    active_after_1m UInt32,
    active_after_5m UInt32,
    active_after_10m UInt32,
    active_after_15m UInt32,
    active_after_30m UInt32,

    retention_1m Float32,
    retention_5m Float32,
    retention_10m Float32,
    retention_15m Float32,
    retention_30m Float32,

    avg_active_seconds Float32,
    median_active_seconds Float32,
    p90_active_seconds Float32,

    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(cohort_minute)
ORDER BY (content_id, cohort_minute, platform, country, app_version);
```

## Cohort definition

Use the minute containing `first_active_at`, not only `VideoSessionStart`.

## Insights enabled

- spike quality,
- early vs late joiner retention,
- platform/country retention,
- app-version regression,
- content retention comparison.

---

# 10. Phase 6 — Content Switching and Cannibalization

## New table: `user_content_transitions`

```sql
CREATE TABLE phoenix_insights.user_content_transitions
(
    user_id String,
    from_content_id Int64,
    from_title String,
    from_category LowCardinality(String),
    from_video_type LowCardinality(String),
    to_content_id Int64,
    to_title String,
    to_category LowCardinality(String),
    to_video_type LowCardinality(String),

    from_session_id String,
    to_session_id String,
    transition_at DateTime64(3),
    gap_seconds Int32,
    from_platform LowCardinality(String),
    to_platform LowCardinality(String),
    transition_type LowCardinality(String),

    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(transition_at)
ORDER BY (transition_at, from_content_id, to_content_id, user_id);
```

## Rules

A switch candidate requires:

```text
same user_id
different content_id
next first_active_at within configurable gap, initially 10 minutes
```

## Transition types

```text
direct_switch
switch_after_background
switch_after_end
parallel_multi_device
return_to_previous_content
```

## Important

Do not classify simultaneous sessions on different devices as a switch. Use overlap to classify them as `parallel_multi_device`.

## Cannibalization metric

```text
viewers arriving from another active content
/
all viewers joining the new content
```

Also compare total SonyLIV concurrency before and after the new content begins.

---

# 11. Phase 7 — Platform Migration and Multi-device Flow

## New table: `user_platform_transitions`

```sql
CREATE TABLE phoenix_insights.user_platform_transitions
(
    user_id String,
    content_id Int64,
    from_platform LowCardinality(String),
    to_platform LowCardinality(String),
    from_session_id String,
    to_session_id String,
    transition_at DateTime64(3),
    gap_seconds Int32,
    overlap_seconds Int32,
    transition_type LowCardinality(String),
    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(transition_at)
ORDER BY (transition_at, from_platform, to_platform, content_id, user_id);
```

## Transition types

```text
handoff
parallel_multi_device
return_to_previous_device
unknown
```

## Suggested handoff rule

```text
same user
same content
platform changes
old session ends/backgrounds
new session becomes active within 5 minutes
little or no overlap
```

---

# 12. Phase 8 — Playback Health Impact

## New table: `playback_health_minute`

```sql
CREATE TABLE phoenix_insights.playback_health_minute
(
    minute DateTime,
    content_id Int64,
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),
    video_type LowCardinality(String),

    active_sessions UInt32,
    video_error_sessions UInt32,
    heartbeat_timeout_sessions UInt32,
    abandoned_sessions UInt32,
    recovered_after_error UInt32,
    returned_after_timeout UInt32,

    video_error_rate Float32,
    heartbeat_timeout_rate Float32,
    abandonment_rate Float32,
    error_recovery_rate Float32,

    version UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(minute)
ORDER BY (minute, content_id, platform, country, app_version);
```

## Insights enabled

- app-version health regression,
- platform-specific playback issue,
- error-driven concurrency drop,
- heartbeat-gap impact,
- incident recovery,
- healthy vs technical spike.

## Suggested incident rule

```text
error_rate > baseline + threshold
OR timeout_rate > baseline + threshold
OR concurrency drops X% within Y minutes
```

---

# 13. Phase 9 — Sports Timeline and Break Analysis

## Existing-data-only version

Infer candidate moments from:

- concurrency spike/drop,
- background burst,
- foreground-return burst,
- content-switching burst.

These are inferred moments, not confirmed sports events.

## Recommended source table: `content_timeline_events`

```sql
CREATE TABLE phoenix_insights.content_timeline_events
(
    content_id Int64,
    event_timestamp DateTime64(3),
    event_type LowCardinality(String),
    event_name String,
    source LowCardinality(String),
    source_event_id String,
    metadata_json String,
    ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(event_timestamp)
ORDER BY (content_id, event_timestamp, event_type, source_event_id);
```

Example event types:

```text
match_start
innings_start
innings_break
halftime
wicket
goal
timeout
rain_delay
final_over
match_end
award_ceremony
```

## Aggregate: `timeline_audience_impact`

Store concurrency before, at, and after each event plus background, return and content-switch behavior.

---

# 14. Phase 10 — Notification Attribution

## Required upstream fields

```text
notification_id
campaign_id
user_id
content_id
sent_at
delivered_at
opened_at
platform
country
```

## New table: `notification_events`

```sql
CREATE TABLE phoenix_insights.notification_events
(
    notification_id String,
    campaign_id String,
    user_id String,
    content_id Int64,
    event_type LowCardinality(String),
    event_timestamp DateTime64(3),
    platform LowCardinality(String),
    country LowCardinality(String),
    arrival_timestamp DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_timestamp)
ORDER BY (campaign_id, user_id, event_timestamp, event_type);
```

## New table: `notification_viewing_attribution`

Store open-to-first-active response, whether the user became active, 5/15-minute retention and attributed active seconds.

---

# 15. Phase 11 — Advertisement Impact

## Required events

```text
ad_break_start
ad_break_end
ad_start
ad_complete
ad_skip
ad_error
```

## New table: `ad_events`

```sql
CREATE TABLE phoenix_insights.ad_events
(
    video_session_id String,
    user_id String,
    content_id Int64,
    ad_break_id String,
    ad_id String,
    event_type LowCardinality(String),
    event_timestamp DateTime64(3),
    platform LowCardinality(String),
    country LowCardinality(String),
    app_version LowCardinality(String),
    arrival_timestamp DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_timestamp)
ORDER BY (content_id, ad_break_id, video_session_id, event_timestamp);
```

Create an `ad_break_audience_impact` aggregate containing concurrency before/during/after the break, exits, background entries, returns and ad errors.

---

# 16. Phase 12 — Forecasting

## New table: `concurrency_forecasts`

```sql
CREATE TABLE phoenix_insights.concurrency_forecasts
(
    generated_at DateTime,
    forecast_for DateTime,
    content_id Int64,
    platform LowCardinality(String),
    country LowCardinality(String),
    current_concurrency UInt32,
    predicted_concurrency UInt32,
    lower_bound UInt32,
    upper_bound UInt32,
    predicted_peak UInt32,
    predicted_peak_at DateTime,
    model_name LowCardinality(String),
    model_version String,
    confidence Float32,
    actual_concurrency Nullable(UInt32),
    absolute_error Nullable(Int32),
    inserted_at DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(generated_at)
ORDER BY (content_id, generated_at, forecast_for, platform, country);
```

Start with a rule-based model using current growth rate and similar historical curves. Add ML later.

---

# 17. Phase 13 — ClickStack Integration

## Required dashboards

### Pipeline health

- insert rate and batch size,
- MV exceptions,
- parts and merge backlog,
- incremental touched-session count,
- derivation failures.

### Data quality

- duplicate events,
- unknown event vocabulary,
- multiple starts/ends,
- playback after session end,
- missing metadata,
- empty `video_type`,
- late events by class.

### Serving health

- query latency,
- rows and bytes read,
- memory,
- queries touching `raw_events`,
- query-budget failures.

### Audience health

- active sessions/users,
- video-error rate,
- timeout rate,
- background rate,
- return rate.

ClickStack can initially read:

```text
system.query_log
system.query_views_log
system.parts
late_event_audit
playback_health_minute
audience_minute_snapshot
```

---

# 18. Phase 14 — Performance Changes

## Keep current sort key initially

The current serving table is very small. Do not perform a risky immutable-key migration only for theoretical benefit.

## Add projection when scale justifies it

```sql
ALTER TABLE phoenix.concurrency_deltas
ADD PROJECTION by_content
(
    SELECT *
    ORDER BY
    (
        content_id,
        platform,
        country,
        video_type,
        app_version,
        minute
    )
);
```

Add app-version or country projections only after measured query volume and table size justify them.

## Add query safeguards

Configure dashboard queries with measured limits:

```text
max_execution_time
max_rows_to_read
max_bytes_to_read
readonly
```

---

# 19. Phase 15 — TTL and Retention

Suggested starting policy:

| Table | Suggested retention |
|---|---|
| `raw_events` | 30–90 days hot |
| `session_state_transitions` | 90 days |
| `session_insight_facts` | 12–18 months |
| `audience_minute_snapshot` | 12–24 months |
| `playback_health_minute` | 12 months |
| `content_entry_cohorts` | 12–24 months |
| `late_event_audit` | 90–180 days |
| Forecast details | 90 days, longer aggregated |

Do not activate TTL before confirming judging, replay and unseen-day requirements.

---

# 20. Recommended Delivery Order

## Phase A — Submission blockers

1. Wire corrected serving queries.
2. Implement ClickStack.
3. Decide session-end behavior.
4. Resolve or explicitly accept derive idempotence behavior.
5. Add trustworthy arrival timestamp and lateness policy.

## Phase B — High-value insights using existing data

1. `session_insight_facts`
2. `session_state_transitions`
3. `audience_minute_snapshot`
4. `concurrency_spike_events`
5. `content_entry_cohorts`
6. `playback_health_minute`

## Phase C — User journey

1. `user_content_transitions`
2. `user_platform_transitions`
3. cannibalization queries
4. device handoff queries

## Phase D — New source integrations

1. sports timeline events
2. notification events
3. advertisement events
4. network/ISP/CDN data

## Phase E — Prediction and AI

1. concurrency forecast
2. anomaly detection
3. natural-language insight summaries
4. LibreChat/Langfuse only after ClickStack and core insights are complete

---

# 21. Recommended First Release

Implement only:

```text
session_insight_facts
session_state_transitions
audience_minute_snapshot
concurrency_spike_events
content_entry_cohorts
playback_health_minute
ClickStack dashboards
```

This release can answer:

- Why did concurrency spike?
- Which platform, country, app version and content contributed?
- Did viewers stay?
- How many backgrounded and returned?
- Did video errors or heartbeat gaps cause a drop?
- Which app version has poor retention?
- Was the spike healthy or short-lived?
- What is infrastructure session load versus unique audience reach?

Do not start notification, advertising or sports-event attribution until their events are available.

---

# 22. Repository Structure

```text
sql/
  insights/
    schema/
      01_session_insight_facts.sql
      02_session_state_transitions.sql
      03_audience_minute_snapshot.sql
      04_concurrency_spike_events.sql
      05_content_entry_cohorts.sql
      06_user_content_transitions.sql
      07_user_platform_transitions.sql
      08_playback_health_minute.sql
      09_late_event_audit.sql

    pipeline/
      01_refresh_session_facts.sql
      02_refresh_state_transitions.sql
      03_refresh_minute_snapshot.sql
      04_detect_spikes.sql
      05_refresh_cohorts.sql
      06_refresh_content_transitions.sql
      07_refresh_platform_transitions.sql
      08_refresh_playback_health.sql

    queries/
      spike_explanation.sql
      spike_retention.sql
      background_return.sql
      app_version_health.sql
      content_cannibalization.sql
      platform_handoff.sql
      technical_incident_impact.sql

scripts/
  refresh_insights.sh
  validate_insights.sh
  rebuild_insight_partition.sh

docs/
  INSIGHT_DATA_MODEL.md
  INSIGHT_RUNBOOK.md
  INSIGHT_DEFINITIONS.md
```

---

# 23. Mandatory Metric Definitions

Create `docs/INSIGHT_DEFINITIONS.md` and define:

- active viewer,
- concurrent session,
- concurrent user,
- session start,
- first play,
- first active,
- background entry,
- foreground return,
- abandoned session,
- heartbeat timeout,
- error recovery,
- content switch,
- platform handoff,
- parallel multi-device usage,
- spike,
- healthy spike,
- short-lived spike,
- retained after 5/10/15 minutes,
- average concurrency,
- lateness,
- finalized minute.

Without shared definitions, dashboards will produce conflicting values.

---

# 24. Acceptance Checklist

## Correctness

- [ ] Existing concurrency outputs remain unchanged.
- [ ] New dashboard queries do not scan raw events repeatedly.
- [ ] Late events revise affected session facts and minutes.
- [ ] Duplicate events do not duplicate insight metrics.
- [ ] Insight refreshes are idempotent.
- [ ] All duration values are non-negative.
- [ ] Session and user metrics remain separate.
- [ ] Content switching excludes parallel multi-device viewing.
- [ ] Dense minute snapshots include quiet minutes.
- [ ] Empty metadata values receive dashboard labels.

## Performance

- [ ] Standard insight queries meet agreed latency.
- [ ] Rows and bytes read are measured.
- [ ] Query safeguards are configured.
- [ ] Projections are added only after measurements justify them.
- [ ] Incremental refresh touches only changed sessions/minutes.

## Submission readiness

- [ ] Correct average query is live in the demo.
- [ ] ClickStack is demonstrable.
- [ ] Session-end rule is documented.
- [ ] Trusted arrival timestamp exists.
- [ ] Lateness policy exists.
- [ ] TTL/retention is documented.
- [ ] Evidence ledger contains no unexplained stale failures.
- [ ] The insight runbook works on unseen data.

---

# 25. Expected Business Output

After the first release, the system should generate insight text such as:

```text
Concurrency increased by 42% in four minutes for the live feed.

ANDROID_PHONE contributed 68% of the increase, while the current app version
accounted for 74% of new active sessions.

The spike was healthy: audience remained above 80% of peak for 12 minutes and
five-minute retention was 81%.

Background entries increased during the break, but 63% of those viewers returned
within six minutes.

Playback error rate remained below 0.4%, so the decline after peak appears
content-driven rather than technical.
```

This extends the project from a concurrency counter into an audience intelligence and operational decision system.

# Phase-wise Correctness and Performance Gates

The following gates apply specifically to the insight tables proposed in this plan.

## Phase 0 Gate — Existing Submission Fixes

### Correctness

- Corrected concurrency and average queries must match an independent dense minute reference.
- Foreground-only peak and average must exclude background, paused, stale-heartbeat, ended, and error time.
- The demo must use the same corrected SQL that passes validation.
- The team must decide whether playback after `VideoSessionEnd` is ignored or becomes a new playback instance.
- Re-running a batch derivation must not double concurrency.

### Performance

- Demo queries must read only `concurrency_deltas` or `user_concurrency_deltas`.
- Record query duration, rows, bytes, and tables from `system.query_log`.
- Capture `EXPLAIN indexes = 1`.
- Add read budgets appropriate to the current serving-table size.

### Exit condition

```text
0 differences versus dense ground truth
0 serving queries reading raw_events
```

---

## Phase 1 Gate — `session_insight_facts`

### Ground truth

Derive facts directly from ordered, deduplicated raw events and the validated state-machine rules.

Validate:

- first active time,
- last active time,
- active duration,
- background duration,
- pause duration,
- heartbeat-gap duration,
- error count,
- return count,
- active-after-1/5/10/15-minute flags.

### Critical foreground test

For each session:

```text
active_seconds
=
sum of intervals where state is playing_foreground
```

No background or paused interval may contribute.

### Performance

Normal dashboard queries must aggregate `session_insight_facts`, not `raw_events`.

Recommended budgets at current volume should be measured for:

- one content,
- one platform,
- one app version,
- one day,
- full corpus.

### Exit condition

- zero session-level fact differences,
- duplicate replay unchanged,
- late-event correction parity,
- no raw scan in insight-serving queries.

---

## Phase 2 Gate — `session_state_transitions`

### Ground truth

Compare the optimized transition table with transitions generated directly from the ordered state sequence.

Validate exact:

- transition timestamp,
- previous state,
- next state,
- trigger event,
- previous-state duration.

### Foreground-only protection

A neutral heartbeat must not create:

```text
background -> playing_foreground
paused_foreground -> playing_foreground
```

Only a documented reopening event can do so.

### Performance

Flow and Sankey queries must read the transition fact table only.

Measure:

- total transitions,
- transition query by content,
- background-return flow,
- error-recovery flow.

---

## Phase 3 Gate — `audience_minute_snapshot`

### Ground truth

For every minute and dimension tuple, compare snapshot metrics with independently computed values from facts and transitions.

Validate:

- concurrent sessions,
- concurrent users,
- starts,
- plays,
- background entries,
- foreground returns,
- errors,
- heartbeat timeouts,
- ends.

### Critical concurrency test

```text
snapshot.concurrent_sessions
=
authoritative concurrency_deltas curve
```

for all benchmark minutes and filters.

### Performance

This table exists to make multi-metric dashboard queries cheap.

Benchmark:

- 1-hour trend,
- 1-day trend,
- peak,
- average,
- filtered content query,
- platform + country + app-version query.

The query must not join raw events at runtime.

---

## Phase 4 Gate — `concurrency_spike_events`

### Ground truth

A spike must be reproducible from the authoritative dense concurrency curve.

Validate:

- baseline,
- peak,
- peak timestamp,
- absolute growth,
- growth percentage,
- minutes above threshold,
- post-peak retention,
- top contributors.

### Correctness warning

Do not calculate contributors by summing independent dimension peaks. Contribution must be measured over the same spike window and time alignment.

### Performance

Spike detection may run as an incremental or scheduled job, but dashboard retrieval must read the spike table.

Measure the detector separately from the dashboard lookup.

---

## Phase 5 Gate — `content_entry_cohorts`

### Ground truth

Build an independent session cohort set from `first_active_at`.

For every cohort:

```text
retained_after_N
=
sessions active at or after cohort_start + N minutes
```

Foreground-only state must be used at the retention checkpoint.

### Correctness warning

Do not treat a session that is backgrounded at minute 5 as retained merely because it has not ended.

### Performance

Retention dashboards must read cohort aggregates, not scan session histories.

Benchmark cohort queries by:

- content,
- platform,
- country,
- app version,
- entry hour.

---

## Phase 6 Gate — Content Switching

### Ground truth

Compare optimized transitions with a direct ordered per-user session timeline.

A direct switch requires:

- same user,
- different content,
- accepted gap,
- and no qualifying parallel overlap.

### Correctness warning

Do not classify simultaneous multi-device watching as switching.

### Performance

Matrix and top-flow queries must read `user_content_transitions`.

At scale, evaluate projections or aggregation tables for:

```text
from_content_id, to_content_id, transition_date
```

---

## Phase 7 Gate — Platform Migration

### Ground truth

Compare against ordered per-user, per-content session intervals.

A handoff requires:

- platform change,
- same content,
- short gap,
- previous session ending/backgrounding,
- limited overlap.

### Performance

Platform flow queries must use `user_platform_transitions`.

Measure:

- mobile-to-TV,
- TV-to-mobile,
- parallel multi-device,
- content-filtered handoff.

---

## Phase 8 Gate — Playback Health

### Ground truth

Validate error and timeout metrics directly from raw events plus state intervals.

Error rate denominator must be documented:

```text
error sessions / active sessions
```

or another explicit definition.

### Correctness warning

A concurrency fall near an error does not prove causation. Label it as correlated impact unless session-level linkage proves affected viewers left.

### Performance

Health dashboards must read `playback_health_minute`.

Benchmark by:

- app version,
- platform,
- content,
- country,
- incident window.

---

## Phase 9 Gate — Sports Timeline Impact

### Ground truth

Use exact timeline timestamps and compare fixed before/after windows.

Validate the window definition:

```text
before: [event - N minutes, event)
after:  [event, event + N minutes)
```

### Correctness warning

An inferred spike is not the same as a known wicket, goal, or break. Keep inferred and externally tagged events separate.

### Performance

Timeline impact queries must read precomputed impact rows or the minute snapshot, not raw playback events.

---

## Phase 10 Gate — Notification Attribution

### Ground truth

Attribution requires a deterministic rule:

```text
notification opened
then first_active_at for the same user/content
within attribution window
```

Maintain an unattributed control or baseline where possible.

### Correctness warning

A concurrency increase after a notification is correlation unless user-level attribution is available.

### Performance

Campaign queries must read attribution aggregates.

---

## Phase 11 Gate — Advertisement Impact

### Ground truth

Link ad events to the same playback session.

Validate:

- users active before the break,
- users backgrounding/exiting during the break,
- users returning after the break,
- ad-error sessions.

### Correctness warning

Do not count naturally ending sessions as ad-driven loss unless their timing and linkage meet the attribution rule.

### Performance

Ad dashboards must read `ad_break_audience_impact`.

---

## Phase 12 Gate — Forecasting

### Correctness

Forecasting is evaluated separately from concurrency correctness.

Track:

- MAE,
- MAPE where denominator is safe,
- peak error,
- peak-time error,
- interval coverage.

Do not replace measured concurrency with forecast values.

### Performance

Forecast generation may be offline or scheduled. Dashboard retrieval must read `concurrency_forecasts`.

---

# Judge-facing Benchmark Matrix

For every important insight, provide one table like this:

| Insight query | Ground-truth parity | Duration | Rows read | Bytes read | Tables read | Raw scan? |
|---|---:|---:|---:|---:|---|---:|
| Foreground concurrency | | | | | | |
| Unique-user concurrency | | | | | | |
| Spike explanation | | | | | | |
| 5-minute retention | | | | | | |
| Background return rate | | | | | | |
| Error impact | | | | | | |
| Content switch matrix | | | | | | |
| Platform handoff | | | | | | |

The strongest submission demonstrates:

```text
correct answer
+ small serving-layer read
+ predictable performance
+ reproducible evidence
```

not merely a visually attractive dashboard.
