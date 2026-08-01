# SonyLIV ClickHouse — 30-Minute Manual Validation Runbook

> **Purpose:** Independently verify the major PASS/FAIL claims in the filled SonyLIV implementation review against the live `phoenix` ClickHouse database.
>
> **Result values:** `PASS`, `FAIL`, `PARTIAL`, `NOT RUN`

## Environment

| Field | Value |
|---|---|
| Reviewer | |
| Validation date | |
| ClickHouse version | |
| Database | `phoenix` |
| Frozen corpus predicate | `event_timestamp < '2026-08-01'` |
| Git commit / branch | |

Keep the frozen-corpus condition on historical checks so manually ingested `2026-08-01` rows do not change the validated result.

---

# Phase 1 — Environment and Objects

## 1. ClickHouse version

```sql
SELECT version();
```

| Status | Actual | Notes |
|---|---|---|
| NOT RUN | | |

## 2. Object inventory

```sql
SELECT name, engine, total_rows, formatReadableSize(total_bytes) AS size
FROM system.tables
WHERE database = 'phoenix'
ORDER BY name;
```

Expected important objects:

- `raw_events`, `raw_events_landing`, `raw_events_mv`
- `content`, `event_state`, `foreground_intervals`
- `session_minute_runs`, `concurrency_deltas`, `concurrency_deltas_mv`
- `user_minute_runs`, `user_concurrency_deltas`, `user_concurrency_deltas_mv`

| Status | Missing objects | Notes |
|---|---|---|
| NOT RUN | | |

## 3. Engines, sort keys, and partitions

```sql
SELECT name, engine, sorting_key, partition_key
FROM system.tables
WHERE database = 'phoenix'
ORDER BY name;
```

Expected:

- Landing table uses a pass-through engine such as `Null`.
- Run tables use a retractable model such as `CollapsingMergeTree`.
- Serving tables use `SummingMergeTree` or another additive engine.
- Raw data is time-partitioned.
- Serving sort key begins with frequently filtered dimensions.

| Status | Findings | Notes |
|---|---|---|
| NOT RUN | | |

## 4. Materialized-view health

```sql
SELECT view_name, status, count() AS executions
FROM system.query_views_log
WHERE event_date >= today() - 7
GROUP BY view_name, status
ORDER BY view_name, status;
```

Expected: successful statuses only; no repeated exceptions.

| Status | Exceptions | Notes |
|---|---:|---|
| NOT RUN | | |

---

# Phase 2 — Source Data

## 5. Raw schema

```sql
DESCRIBE TABLE phoenix.raw_events;
```

Expected source columns:

`video_session_id`, `user_id`, `content_id`, `event_type`, `event`, `event_timestamp`, `platform`, `app_version`, `country`, `audio_language`, `subtitle_language`, `player_version`, `session_start_epoch`.

| Status | Missing/wrong columns | Notes |
|---|---|---|
| NOT RUN | | |

## 6. Frozen-corpus volume

```sql
SELECT
    count() AS rows,
    uniqExact(video_session_id) AS sessions,
    uniqExact(user_id) AS users,
    uniqExact(content_id) AS contents,
    min(event_timestamp) AS first_event,
    max(event_timestamp) AS last_event
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01';
```

Expected from the filled review:

| Metric | Expected |
|---|---:|
| Rows | `905558` |
| Sessions | `10866` |
| Users | `9618` |
| Contents | `3357` |

| Status | Rows | Sessions | Users | Contents |
|---|---:|---:|---:|---:|
| NOT RUN | | | | |

## 7. Event-type distribution

```sql
SELECT event_type, count() AS rows, uniqExact(event) AS distinct_events
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01'
GROUP BY event_type
ORDER BY rows DESC;
```

Expected event types:

`VideoHeartbeat`, `AppBackgrounded`, `AppForegrounded`, `VideoPlay`, `VideoSessionEnd`, `VideoSessionStart`, `VideoError`.

| Status | Missing values | Notes |
|---|---|---|
| NOT RUN | | |

## 8. Content volume and uniqueness

```sql
SELECT count() AS rows, uniqExact(content_id) AS unique_ids
FROM phoenix.content;
```

Expected: `33464` rows and `33464` unique IDs.

| Status | Rows | Unique IDs | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

## 9. Duplicate content IDs

```sql
SELECT content_id, count() AS duplicate_count
FROM phoenix.content
GROUP BY content_id
HAVING duplicate_count > 1
ORDER BY duplicate_count DESC
LIMIT 100;
```

Expected: zero rows.

| Status | Duplicate IDs | Notes |
|---|---:|---|
| NOT RUN | | |

## 10. Content enrichment completeness

```sql
SELECT count() AS unmatched_event_rows,
       uniqExact(r.content_id) AS unmatched_content_ids
FROM phoenix.raw_events AS r
LEFT ANTI JOIN phoenix.content AS c ON r.content_id = c.content_id
WHERE r.event_timestamp < '2026-08-01';
```

Expected: `0`, `0`.

| Status | Unmatched rows | IDs | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

---

# Phase 3 — Data Quality and Deduplication

## 11. Required-field quality

```sql
SELECT
    countIf(video_session_id = '') AS missing_session,
    countIf(user_id = '') AS missing_user,
    countIf(event_type = '') AS missing_event_type,
    countIf(content_id = 0) AS zero_content,
    countIf(event_timestamp < session_start_epoch) AS events_before_start
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01';
```

Expected: all zero.

| Status | Actual | Notes |
|---|---|---|
| NOT RUN | | |

## 12. Duplicate source events

```sql
SELECT count() AS duplicate_groups, sum(c - 1) AS excess_rows
FROM
(
    SELECT video_session_id, event_timestamp, event_type, event, count() AS c
    FROM phoenix.raw_events
    WHERE event_timestamp < '2026-08-01'
    GROUP BY video_session_id, event_timestamp, event_type, event
    HAVING c > 1
);
```

Expected review values: `3413` groups and `4210` excess rows.

| Status | Groups | Excess rows | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

## 13. Multiple starts and ends

```sql
SELECT
    countIf(starts > 1) AS multiple_starts,
    countIf(ends > 1) AS multiple_ends,
    countIf(starts = 0) AS missing_start,
    countIf(ends = 0) AS missing_end
FROM
(
    SELECT video_session_id,
           countIf(event_type = 'VideoSessionStart') AS starts,
           countIf(event_type = 'VideoSessionEnd') AS ends
    FROM phoenix.raw_events
    WHERE event_timestamp < '2026-08-01'
    GROUP BY video_session_id
);
```

Expected review values: `13`, `14`, `0`, `0`.

| Status | Actual | Notes |
|---|---|---|
| NOT RUN | | |

## 14. Sessions with changing dimensions

```sql
SELECT
    countIf(platforms > 1) AS multi_platform_sessions,
    countIf(users > 1) AS multi_user_sessions,
    countIf(contents > 1) AS multi_content_sessions
FROM
(
    SELECT video_session_id,
           uniqExact(platform) AS platforms,
           uniqExact(user_id) AS users,
           uniqExact(content_id) AS contents
    FROM phoenix.raw_events
    WHERE event_timestamp < '2026-08-01'
    GROUP BY video_session_id
);
```

Confirm that dimension pinning is deterministic for these dirty sessions.

| Status | Actual | Pinning verified? | Notes |
|---|---|---|---|
| NOT RUN | | | |

---

# Phase 4 — Foreground State Logic

## 15. Inspect state-machine definition

```sql
SHOW CREATE TABLE phoenix.event_state;
```

Verify manually:

- Ordering uses `event_timestamp`, not ingestion order.
- Duplicate events collapse before state derivation.
- Background, end, error and pause close activity.
- Start, play, foreground and resume activate activity.
- Neutral heartbeat values do not reopen a paused/backgrounded session.
- A close wins for contradictory events at the same millisecond.
- A timeout/tolerance cap is applied.

| Status | Findings | Notes |
|---|---|---|
| NOT RUN | | |

## 16. Event classification visibility

```sql
SELECT event_type, event, count() AS rows
FROM phoenix.event_state
WHERE event_timestamp < '2026-08-01'
GROUP BY event_type, event
ORDER BY event_type, rows DESC;
```

Confirm the implementation exposes or derives deterministic classifications.

| Status | Neutral heartbeat verified? | Notes |
|---|---|---|
| NOT RUN | | |

## 17. Intervals after known session end

```sql
WITH session_ends AS
(
    SELECT video_session_id,
           maxIf(event_timestamp, event_type = 'VideoSessionEnd') AS session_end
    FROM phoenix.raw_events
    WHERE event_timestamp < '2026-08-01'
    GROUP BY video_session_id
)
SELECT count() AS invalid_intervals
FROM phoenix.foreground_intervals AS i
INNER JOIN session_ends AS e USING (video_session_id)
WHERE e.session_end IS NOT NULL
  AND i.interval_end > e.session_end;
```

Expected: `0`.

| Status | Invalid intervals | Notes |
|---|---:|---|
| NOT RUN | | |

## 18. Backwards and zero-length intervals

```sql
SELECT
    countIf(interval_end < interval_start) AS backwards,
    countIf(interval_end = interval_start) AS zero_length,
    countIf(interval_end > interval_start) AS positive,
    count() AS total
FROM phoenix.foreground_intervals
WHERE interval_start < '2026-08-01';
```

Expected review result: `0` backwards; many zero-length rows due to second precision. Backwards rows are a failure. Zero-length rows are a documented P2 issue if minute output remains correct.

| Status | Backwards | Zero-length | Positive | Notes |
|---|---:|---:|---:|---|
| NOT RUN | | | | |

## 19. Overlapping session runs

```sql
WITH ordered AS
(
    SELECT video_session_id, run_start, run_end,
           lagInFrame(run_end) OVER
           (PARTITION BY video_session_id ORDER BY run_start) AS previous_end
    FROM phoenix.session_minute_runs FINAL
    WHERE run_start < '2026-08-01'
)
SELECT count() AS overlaps
FROM ordered
WHERE previous_end IS NOT NULL
  AND run_start < previous_end;
```

Expected: `0`.

| Status | Overlaps | Notes |
|---|---:|---|
| NOT RUN | | |

## 20. Maximum one run per session-minute

```sql
SELECT max(c) AS max_runs_per_session_minute
FROM
(
    SELECT video_session_id,
           arrayJoin(timeSlots(run_start,
                               toUInt32(dateDiff('second', run_start, run_end)),
                               60)) AS minute,
           count() AS c
    FROM phoenix.session_minute_runs FINAL
    WHERE run_start < '2026-08-01'
    GROUP BY video_session_id, minute
);
```

Expected: `1`.

| Status | Actual maximum | Notes |
|---|---:|---|
| NOT RUN | | |

---

# Phase 5 — Serving-Layer Integrity

## 21. Session delta balance

```sql
SELECT sum(delta) AS net_delta
FROM phoenix.concurrency_deltas
WHERE minute < '2026-08-01';
```

Expected: `0`.

| Status | Net delta | Notes |
|---|---:|---|
| NOT RUN | | |

## 22. User delta balance

```sql
SELECT sum(delta) AS net_delta
FROM phoenix.user_concurrency_deltas
WHERE minute < '2026-08-01';
```

Expected: `0`.

| Status | Net delta | Notes |
|---|---:|---|
| NOT RUN | | |

## 23. Session concurrency invariants

```sql
WITH per_minute AS
(
    SELECT minute, sum(delta) AS delta
    FROM phoenix.concurrency_deltas
    WHERE minute < '2026-08-01'
    GROUP BY minute
),
curve AS
(
    SELECT minute, sum(delta) OVER (ORDER BY minute) AS concurrency
    FROM per_minute
)
SELECT min(concurrency) AS minimum_concurrency,
       max(concurrency) AS peak_concurrency,
       count() AS delta_minutes
FROM curve;
```

Expected: minimum `0`, peak `2829`.

| Status | Minimum | Peak | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

## 24. User concurrency invariants

```sql
WITH per_minute AS
(
    SELECT minute, sum(delta) AS delta
    FROM phoenix.user_concurrency_deltas
    WHERE minute < '2026-08-01'
    GROUP BY minute
),
curve AS
(
    SELECT minute, sum(delta) OVER (ORDER BY minute) AS concurrency
    FROM per_minute
)
SELECT min(concurrency) AS minimum_concurrency,
       max(concurrency) AS peak_concurrency,
       count() AS delta_minutes
FROM curve;
```

Expected: minimum `0`, peak `2749`.

| Status | Minimum | Peak | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

## 25. Session versus user peak

```sql
WITH session_curve AS
(
    SELECT minute, sum(sum(delta)) OVER (ORDER BY minute) AS concurrency
    FROM phoenix.concurrency_deltas
    WHERE minute < '2026-08-01'
    GROUP BY minute
),
user_curve AS
(
    SELECT minute, sum(sum(delta)) OVER (ORDER BY minute) AS concurrency
    FROM phoenix.user_concurrency_deltas
    WHERE minute < '2026-08-01'
    GROUP BY minute
)
SELECT
    (SELECT max(concurrency) FROM session_curve) AS session_peak,
    (SELECT max(concurrency) FROM user_curve) AS user_peak,
    session_peak - user_peak AS difference;
```

Expected: approximately `2829`, `2749`, difference `80`.

| Status | Session peak | User peak | Difference |
|---|---:|---:|---:|
| NOT RUN | | | |

---

# Phase 6 — Peak and Average Correctness

## 26. Correct global peak

```sql
WITH per_minute AS
(
    SELECT minute, sum(delta) AS delta
    FROM phoenix.concurrency_deltas
    WHERE minute < '2026-08-01'
    GROUP BY minute
),
curve AS
(
    SELECT minute, sum(delta) OVER (ORDER BY minute) AS concurrency
    FROM per_minute
)
SELECT max(concurrency) AS peak,
       argMax(minute, concurrency) AS peak_minute
FROM curve;
```

Expected: peak `2829` around `2026-07-26 10:56:00`.

| Status | Peak | Peak minute | Notes |
|---|---:|---|---|
| NOT RUN | | | |

## 27. Filter-aware peak

```sql
WITH per_minute AS
(
    SELECT minute, sum(delta) AS delta
    FROM phoenix.concurrency_deltas
    WHERE minute < '2026-08-01'
      AND video_type = 'live'
    GROUP BY minute
),
curve AS
(
    SELECT minute, sum(delta) OVER (ORDER BY minute) AS concurrency
    FROM per_minute
)
SELECT max(concurrency) AS peak,
       argMax(minute, concurrency) AS peak_minute
FROM curve;
```

Pass condition: peak is calculated after filtering and may occur at a different minute from the unfiltered peak.

| Status | Peak | Peak minute | Notes |
|---|---:|---|---|
| NOT RUN | | | |

## 28. Correct densified full-day average

```sql
WITH
    toDateTime('2026-07-26 00:00:00') AS from_ts,
    toDateTime('2026-07-27 00:00:00') AS to_ts,
    deltas AS
    (
        SELECT minute, sum(delta) AS delta
        FROM phoenix.concurrency_deltas
        WHERE minute < to_ts
        GROUP BY minute
    ),
    curve AS
    (
        SELECT minute, sum(delta) OVER (ORDER BY minute) AS concurrency
        FROM deltas
    ),
    requested_minutes AS
    (
        SELECT arrayJoin(timeSlots(from_ts,
                                   toUInt32(dateDiff('second', from_ts, to_ts) - 60),
                                   60)) AS minute
    )
SELECT round(avg(ifNull(c.concurrency, 0)), 2) AS correct_average,
       count() AS denominator_minutes
FROM requested_minutes AS m
LEFT JOIN curve AS c USING (minute);
```

Expected from prior review: denominator `1440`, average approximately `87.82`.

| Status | Average | Denominator | Notes |
|---|---:|---:|---|
| NOT RUN | | | |

## 29. Test repository `concurrency.sql`

Run the actual dashboard query using:

```text
from = 2026-07-26 00:00:00
to   = 2026-07-27 00:00:00
```

Record the first minute, last minute, returned row count and calculated average.

Prior failure signature:

- First row around `00:10`
- Last row around `11:32`
- Around `683` minutes
- Average around `185.95`

| Status | First | Last | Rows | Average |
|---|---|---|---:|---:|
| NOT RUN | | | | |

Pass after fix: full requested range is represented and average matches Test 28.

## 30. Test repository `peak_average.sql`

Run it for the same full day.

Prior failure signature: denominator around `512`, average around `246.98` because zero-concurrency minutes are skipped.

| Status | Denominator | Average | Matches Test 28? |
|---|---:|---:|---|
| NOT RUN | | | |

## 31. Verify bounded `WITH FILL`

The corrected query should have explicit range bounds, similar to:

```sql
ORDER BY minute
WITH FILL
    FROM parseDateTimeBestEffort({from_ts:String})
    TO parseDateTimeBestEffort({to_ts:String})
    STEP toIntervalMinute(1)
INTERPOLATE (concurrency AS concurrency)
```

| Status | Fixed? | Notes |
|---|---|---|
| NOT RUN | | |

---

# Phase 7 — Filter Coverage

## 32. Serving columns

```sql
DESCRIBE TABLE phoenix.concurrency_deltas;
```

Expected core columns: `minute`, `platform`, `country`, `video_type`, `content_id`, `app_version`, `delta`.

| Status | Missing columns | Notes |
|---|---|---|
| NOT RUN | | |

## 33. Dimension-value quality

```sql
SELECT
    groupUniqArray(platform) AS platforms,
    groupUniqArray(country) AS countries,
    groupUniqArray(video_type) AS video_types
FROM phoenix.concurrency_deltas
WHERE minute < '2026-08-01';
```

Check aliases such as `ANDROID_PHONE`/`android`, `FIRE_TV`/`firetv`, and `IN`/`india`.

| Status | Dirty aliases | Normalization documented? |
|---|---|---|
| NOT RUN | | |

## 34. Title and category support

Inspect `concurrency_deltas` and the dashboard query path.

| Status | Title filter | Category filter | Notes |
|---|---|---|---|
| NOT RUN | | | |

Prior review finding: neither is carried in the serving table, even though both are mentioned in the problem requirements.

---

# Phase 8 — Performance

## 35. Flush query logs

```sql
SYSTEM FLUSH LOGS;
```

Then run representative dashboard queries.

## 36. Query latency and reads

```sql
SELECT event_time, query_duration_ms, read_rows,
       formatReadableSize(read_bytes) AS read_size,
       result_rows, tables, query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 30 MINUTE
  AND (has(tables, 'phoenix.concurrency_deltas')
       OR has(tables, 'phoenix.user_concurrency_deltas'))
ORDER BY event_time DESC
LIMIT 30;
```

Expected on reviewed data: roughly `8–9 ms`, reading `8192–26904` rows.

| Status | Min ms | Max ms | Max rows | Notes |
|---|---:|---:|---:|---|
| NOT RUN | | | | |

## 37. Confirm dashboard does not scan raw events

```sql
SELECT count() AS dashboard_queries_touching_raw
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 30 MINUTE
  AND has(tables, 'phoenix.raw_events')
  AND (query ILIKE '%concurrency%'
       OR query ILIKE '%peak%'
       OR query ILIKE '%average%');
```

Expected: `0` for normal dashboard-serving queries.

| Status | Count | Notes |
|---|---:|---|
| NOT RUN | | |

## 38. Explain index pruning

```sql
EXPLAIN indexes = 1
SELECT minute, sum(delta)
FROM phoenix.concurrency_deltas
WHERE platform = 'ANDROID_PHONE'
  AND country = 'IN'
  AND minute < '2026-08-01'
GROUP BY minute
ORDER BY minute;
```

| Status | Pruning visible? | Notes |
|---|---|---|
| NOT RUN | | |

## 39. Compare filter shapes

Run the same query with:

1. No dimension filter
2. Platform
3. Platform + country
4. Platform + country + content

| Shape | Rows read | Duration | Status |
|---|---:|---:|---|
| None | | | |
| Platform | | | |
| Platform + country | | | |
| Four dimensions | | | |

Pass condition: leading-key filters reduce rows read.

---

# Phase 9 — Incremental and Late Corrections

## 40. Physical sign rows

```sql
SELECT sign, count() AS rows
FROM phoenix.session_minute_runs
GROUP BY sign
ORDER BY sign;
```

Then:

```sql
SELECT count() AS logical_rows
FROM phoenix.session_minute_runs FINAL;
```

Both positive and negative physical rows may exist. The logical result must remain correct.

| Status | Findings | Notes |
|---|---|---|
| NOT RUN | | |

## 41. Verify correction path

```sql
SHOW CREATE TABLE phoenix.session_minute_runs;
SHOW CREATE TABLE phoenix.concurrency_deltas_mv;
```

Verify:

- `sign = -1` retracts old runs.
- `sign = +1` asserts corrected runs.
- The materialized view emits additive concurrency deltas.
- The implementation does not expect an MV to reread changed source rows.

| Status | Valid? | Notes |
|---|---|---|
| NOT RUN | | |

## 42. Lateness boundary

Search the repository/configuration for:

```text
lateness
watermark
allowed_lateness
late_event
dead_letter
quarantine
```

| Status | Boundary exists? | Quarantine exists? | Notes |
|---|---|---|---|
| NOT RUN | | | |

Prior review result: no formal boundary and no quarantine path.

## 43. Ingestion timestamp safety

```sql
SHOW CREATE TABLE phoenix.raw_events;
```

If `ingested_at` exists, confirm it is explicitly written at ingestion. Do not use a retroactively added `DEFAULT now()` column as a watermark without proving stored behavior.

| Status | Safe watermark? | Notes |
|---|---|---|
| NOT RUN | | |

---

# Phase 10 — Submission Readiness

## 44. External integration

Search the repository for:

```text
ClickStack
HyperDX
Langfuse
LibreChat
OpenTelemetry
OTEL
MCP
```

| Integration | Code/config exists? | Demonstrable? | Real pipeline data? |
|---|---|---|---|
| ClickStack | | | |
| Langfuse | | | |
| LibreChat | | | |

At least one must be meaningful, not only mentioned in prose.

## 45. Reproducibility files

| Item | Present? | Works? | Notes |
|---|---|---|---|
| `scripts/init_db.sh` | | | |
| `scripts/load.sh` | | | |
| Numbered pipeline SQL | | | |
| Benchmark SQL | | | |
| Evidence artifacts | | | |
| Unseen-day runbook | | | |

## 46. Evidence ledger

Review `evidence/LEDGER.tsv`.

Pass condition:

- Claims map to scripts and artifacts.
- Git SHA and UTC timestamp exist.
- No unresolved `FAIL` row remains.

| Status | Unresolved failures | Notes |
|---|---:|---|
| NOT RUN | | |

Prior issue: `naive_baseline_gate` remained unresolved.

## 47. TTL and retention

```sql
SELECT name, create_table_query
FROM system.tables
WHERE database = 'phoenix'
  AND name IN ('raw_events', 'foreground_intervals',
               'session_minute_runs', 'concurrency_deltas');
```

| Status | TTL configured? | Retention documented? | Notes |
|---|---|---|---|
| NOT RUN | | | |

## 48. Query safeguards

Inspect dashboard SQL/settings for:

```text
max_rows_to_read
max_bytes_to_read
max_execution_time
readonly
```

| Status | Safeguards present? | Notes |
|---|---|---|
| NOT RUN | | |

---

# Final Decision

## Blocking checks

| Requirement | Status |
|---|---|
| Foreground/background logic | NOT RUN |
| Heartbeat timeout | NOT RUN |
| Duplicate neutralization | NOT RUN |
| No negative concurrency | NOT RUN |
| Peak correctness | NOT RUN |
| Average correctness | NOT RUN |
| Dashboard uses serving layer | NOT RUN |
| Open/late correction path | NOT RUN |
| External integration | NOT RUN |
| Unseen-day reproducibility | NOT RUN |

## Decision rule

**APPROVED** only when all blocking correctness checks pass, average concurrency is fixed, a meaningful external integration works, and no unresolved evidence failure remains.

**APPROVED WITH CONDITIONS** when the core engine is correct but a small number of clearly owned submission tasks remain.

**REWORK REQUIRED** when average remains incorrect, background or stale time is counted, dashboard queries scan raw history, duplicate/late events inflate results, or the required external integration remains absent.

## Required fixes tracker

| Priority | Fix | Owner | Due date | Status |
|---|---|---|---|---|
| P0 | Fix full-range average densification | | | |
| P0 | Implement ClickStack/Langfuse/LibreChat | | | |
| P1 | Define and measure lateness boundary | | | |
| P1 | Add unseen-day runbook | | | |
| P1 | Resolve evidence-ledger failure | | | |
| P2 | Add title/category support if required | | | |
| P2 | Capture EXPLAIN and read-budget evidence | | | |
| P2 | Document TTL and 100x scale behavior | | | |

## Sign-off

```text
[ ] APPROVED
[ ] APPROVED WITH CONDITIONS
[ ] REWORK REQUIRED
[ ] REJECTED
```

| Role | Name | Date | Approval |
|---|---|---|---|
| Implementer | | | |
| Reviewer | | | |
| Team lead | | | |
