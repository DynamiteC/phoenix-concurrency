# SonyLIV Click-a-thon 2026 — Implementation Validation Checklist

> **Purpose:** Use this document to validate whether the ClickHouse implementation created by a team member correctly satisfies the SonyLIV foreground-only concurrency problem statement.
>
> **Validation status values:** `PASS`, `FAIL`, `PARTIAL`, `NOT TESTED`
>
> **Important:** A table existing is not enough. The implementation must prove correctness, incremental update handling, query performance, filter support, and pipeline reproducibility.

---

## 1. Validation Summary

| Area | Status | Evidence / Notes |
|---|---|---|
| Raw event ingestion | NOT TESTED | |
| Content metadata ingestion | NOT TESTED | |
| Schema matches source datasets | NOT TESTED | |
| Event-to-content enrichment | NOT TESTED | |
| Duplicate event handling | NOT TESTED | |
| Late-arriving event handling | NOT TESTED | |
| Foreground/background state logic | NOT TESTED | |
| Heartbeat-gap handling | NOT TESTED | |
| Session-aware aggregation | NOT TESTED | |
| Session-independent aggregation | NOT TESTED | |
| Open-session incremental updates | NOT TESTED | |
| Minute concurrency serving table | NOT TESTED | |
| Peak concurrency queries | NOT TESTED | |
| Average concurrency queries | NOT TESTED | |
| Dimension filters | NOT TESTED | |
| Hour/day aggregation | NOT TESTED | |
| Query latency | NOT TESTED | |
| Rows/bytes scanned | NOT TESTED | |
| 100× scalability explanation | NOT TESTED | |
| ClickStack/Langfuse/LibreChat integration | NOT TESTED | |
| Pipeline evidence and reproducibility | NOT TESTED | |

### Final result

- **Overall status:** `NOT TESTED`
- **Critical failures:**
- **Major risks:**
- **Recommended fixes:**
- **Validated by:**
- **Validation date:**

---

# 2. Required Source Data

The implementation must load and use both datasets.

## 2.1 Raw event dataset

Expected logical columns:

| Column | Expected purpose | Present? | Correct type? | Notes |
|---|---|---:|---:|---|
| `video_session_id` | Unique video playback session | [ ] | [ ] | |
| `user_id` | User identifier | [ ] | [ ] | |
| `content_id` | Content identifier and join key | [ ] | [ ] | |
| `event_type` | Playback or application state event type | [ ] | [ ] | |
| `event` | Actual event value | [ ] | [ ] | |
| `event_timestamp` | Event-time timestamp | [ ] | [ ] | |
| `platform` | Filter dimension | [ ] | [ ] | |
| `app_version` | Filter dimension | [ ] | [ ] | |
| `country` | Filter dimension | [ ] | [ ] | |
| `audio_language` | Filter dimension | [ ] | [ ] | |
| `subtitle_language` | Filter dimension | [ ] | [ ] | |
| `player_version` | Filter dimension | [ ] | [ ] | |
| `session_start_epoch` | Session start time | [ ] | [ ] | |

Expected `event_type` values include:

- `VideoSessionStart`
- `VideoPlay`
- `VideoHeartbeat`
- `AppBackgrounded`
- `AppForegrounded`
- `VideoSessionEnd`
- `VideoError`

### Validation queries

```sql
DESCRIBE TABLE <database>.<raw_events_table>;

SELECT
    event_type,
    count() AS rows
FROM <database>.<raw_events_table>
GROUP BY event_type
ORDER BY rows DESC;

SELECT
    count() AS total_rows,
    uniqExact(video_session_id) AS sessions,
    uniqExact(user_id) AS users,
    uniqExact(content_id) AS contents,
    min(event_timestamp) AS first_event,
    max(event_timestamp) AS last_event
FROM <database>.<raw_events_table>;
```

### Checks

- [ ] Approximately the expected raw event volume was loaded.
- [ ] No source columns were silently dropped.
- [ ] `event_timestamp` is stored as `DateTime` or preferably `DateTime64`.
- [ ] Timezone handling is documented.
- [ ] `content_id` type matches the content metadata table.
- [ ] Session and user IDs are not accidentally converted to lossy numeric types.
- [ ] Raw data remains available for debugging and replay.
- [ ] Source-row count and loaded-row count were compared.

---

## 2.2 Content metadata dataset

Expected columns:

| Column | Expected purpose | Present? | Correct type? | Notes |
|---|---|---:|---:|---|
| `content_id` | Join key | [ ] | [ ] | |
| `title` | Filter/display dimension | [ ] | [ ] | |
| `video_type` | Filter dimension | [ ] | [ ] | |
| `category` | Filter dimension | [ ] | [ ] | |

### Validation queries

```sql
DESCRIBE TABLE <database>.<content_table>;

SELECT
    count() AS total_rows,
    uniqExact(content_id) AS unique_content_ids
FROM <database>.<content_table>;

SELECT content_id, count() AS duplicate_count
FROM <database>.<content_table>
GROUP BY content_id
HAVING duplicate_count > 1
ORDER BY duplicate_count DESC
LIMIT 100;
```

### Checks

- [ ] Approximately the expected content volume was loaded.
- [ ] `content_id` is unique or duplicate-handling logic is documented.
- [ ] Content metadata is available during aggregation or serving.
- [ ] Unknown/unmatched content IDs are measurable.
- [ ] Metadata changes or duplicate versions cannot multiply event rows unexpectedly.

---

# 3. ClickHouse Table Architecture

List every table, view, dictionary, and materialized view created by the implementation.

| Object | Type/Engine | Purpose | Source | Destination/Consumer | Status |
|---|---|---|---|---|---|
| | | | | | |

### Inventory queries

```sql
SHOW TABLES FROM <database>;

SELECT
    database,
    name,
    engine,
    total_rows,
    total_bytes
FROM system.tables
WHERE database = '<database>'
ORDER BY name;

SELECT
    database,
    table,
    partition,
    sum(rows) AS rows,
    formatReadableSize(sum(bytes_on_disk)) AS disk_size
FROM system.parts
WHERE active
  AND database = '<database>'
GROUP BY database, table, partition
ORDER BY table, partition;
```

### Checks

- [ ] Raw ingestion table exists.
- [ ] Content metadata table or dictionary exists.
- [ ] Enriched event layer exists or enrichment strategy is clearly implemented.
- [ ] Session-aware state/interval layer exists.
- [ ] Session-independent layer exists.
- [ ] A dashboard-facing serving table exists.
- [ ] Materialized views have valid source and destination tables.
- [ ] No materialized view points to the wrong schema or database.
- [ ] Table engines are justified.
- [ ] `ORDER BY` keys support real query filters.
- [ ] Partitioning is based on a useful time boundary.
- [ ] High-cardinality dimensions are not placed blindly in every aggregation key.
- [ ] Nullable/default values are intentionally handled.
- [ ] Retention/TTL decisions are documented if used.

---

# 4. Foreground-Only Business Logic

This is the most important validation area.

An open session must **not** automatically count as active. Backgrounded, paused, stale, errored, or heartbeat-missing time must not be counted unless the team's documented rules explicitly justify it.

## 4.1 Required documented decisions

| Decision | Team implementation | Status | Notes |
|---|---|---|---|
| Which events start active playback? | | NOT TESTED | |
| Which events stop active playback? | | NOT TESTED | |
| Does `VideoSessionStart` count immediately? | | NOT TESTED | |
| Does `VideoPlay` start/resume activity? | | NOT TESTED | |
| Does `AppBackgrounded` stop activity immediately? | | NOT TESTED | |
| Does `AppForegrounded` resume immediately or wait for play/heartbeat? | | NOT TESTED | |
| Does `VideoSessionEnd` close activity? | | NOT TESTED | |
| Does `VideoError` close activity? | | NOT TESTED | |
| What heartbeat gap marks a session inactive? | | NOT TESTED | |
| What is the session timeout? | | NOT TESTED | |
| How are missing background/foreground events handled? | | NOT TESTED | |
| How are out-of-order events handled? | | NOT TESTED | |
| How are identical duplicate events handled? | | NOT TESTED | |
| How are contradictory events resolved? | | NOT TESTED | |

### Mandatory checks

- [ ] Backgrounded intervals are excluded.
- [ ] Time after a missing/stale heartbeat is excluded.
- [ ] Time after session end is excluded.
- [ ] Time after an unrecovered video error is excluded.
- [ ] Foregrounding does not incorrectly count playback that remains paused.
- [ ] A session cannot contribute more than `1` to session concurrency at one instant.
- [ ] Repeated heartbeat rows do not multiply concurrency.
- [ ] The active-state rule is written clearly enough to reproduce independently.

---

# 5. Session-Aware Model Validation

The session-aware approach should derive active ranges within each `video_session_id`.

## 5.1 Representation

Select the implemented model:

- [ ] Interval arrays per session
- [ ] One normalized row per active interval
- [ ] Session state snapshots
- [ ] Versioned session record
- [ ] Collapsing/replacing model
- [ ] Hybrid model
- [ ] Other:

### Required interval properties

For each active interval:

```text
active_start < active_end
```

and intervals for the same session should not overlap after finalization.

### Suggested checks

```sql
-- Replace names according to the team's schema.
SELECT *
FROM <database>.<session_intervals_table>
WHERE active_end <= active_start
LIMIT 100;

SELECT
    video_session_id,
    count() AS interval_count,
    min(active_start) AS first_active,
    max(active_end) AS last_active
FROM <database>.<session_intervals_table>
GROUP BY video_session_id
ORDER BY interval_count DESC
LIMIT 100;
```

### Overlap validation template

```sql
WITH ordered AS
(
    SELECT
        video_session_id,
        active_start,
        active_end,
        lagInFrame(active_end) OVER
        (
            PARTITION BY video_session_id
            ORDER BY active_start
        ) AS previous_end
    FROM <database>.<session_intervals_table>
)
SELECT *
FROM ordered
WHERE previous_end IS NOT NULL
  AND active_start < previous_end
LIMIT 100;
```

### Checks

- [ ] Every active interval belongs to one session.
- [ ] Active intervals do not extend before the session start.
- [ ] Active intervals do not extend after a known session end.
- [ ] Background events split or close intervals correctly.
- [ ] Heartbeat timeout closes stale intervals.
- [ ] Open sessions are distinguishable from finalized sessions.
- [ ] Late events can correct previously emitted intervals.
- [ ] Corrections do not leave duplicate active intervals.
- [ ] Reprocessing the same event batch is idempotent.

---

# 6. Session-Independent Model Validation

The package expects a session-independent method that derives foreground viewers directly from event state, then compares it with the session-aware approach.

### Checks

- [ ] A separate session-independent aggregate or query exists.
- [ ] It is not merely an alias of the session-aware table.
- [ ] Its state transition logic is documented.
- [ ] It correctly handles background and foreground events.
- [ ] It correctly handles heartbeat gaps.
- [ ] Its concurrency can be compared at the same time grain and dimensions.
- [ ] Differences between both approaches are measurable.
- [ ] The team can explain why differences occur.

### Comparison query template

```sql
SELECT
    a.minute,
    a.platform,
    a.country,
    a.content_id,
    a.concurrent_sessions AS session_aware,
    b.concurrent_viewers AS session_independent,
    session_independent - session_aware AS difference,
    abs(difference) AS absolute_difference
FROM <database>.<session_aware_minute_view> AS a
FULL OUTER JOIN <database>.<session_independent_minute_view> AS b
    USING (minute, platform, country, content_id)
WHERE abs(difference) > 0
ORDER BY absolute_difference DESC
LIMIT 500;
```

---

# 7. Deduplication Validation

Repeated events must not change the final answer.

## 7.1 Define the deduplication key

Document the exact key:

```text
Example only:
(video_session_id, event_timestamp, event_type, event)
```

Actual key:

```text
________________________________________________________
```

### Checks

- [ ] Duplicate definition is explicit.
- [ ] Exact duplicates are removed or neutralized.
- [ ] Duplicate removal happens before concurrency inflation.
- [ ] Deduplication remains correct across separate insert batches.
- [ ] The implementation does not rely only on `SELECT DISTINCT` at dashboard query time.
- [ ] Re-inserting the same source file leaves final aggregates unchanged.

### Idempotency test

1. Record baseline aggregate checksum.
2. Reinsert the exact same test batch.
3. Re-run checksum.
4. Confirm no concurrency result changed.

```sql
SELECT
    sum(cityHash64(*)) AS checksum,
    count() AS rows
FROM <database>.<serving_table>
WHERE <test_day_filter>;
```

| Test | Before | After duplicate replay | Result |
|---|---:|---:|---|
| Row count | | | |
| Checksum | | | |
| Peak concurrency | | | |
| Average concurrency | | | |

---

# 8. Late and Out-of-Order Event Validation

The solution must work using event time rather than assuming arrival order is perfect.

## 8.1 Required decisions

| Decision | Value |
|---|---|
| Maximum accepted lateness | |
| Watermark/finalization delay | |
| How finalized buckets are corrected | |
| How late session-end events are handled | |
| How late background events are handled | |
| How very late events are quarantined or replayed | |

### Test

Insert these events deliberately out of order:

```text
10:00 VideoSessionStart
10:01 VideoPlay
10:04 AppForegrounded
10:03 AppBackgrounded   <-- inserted after 10:04
10:05 VideoHeartbeat
10:06 VideoSessionEnd
```

Expected active intervals must follow event time, not insert time.

### Checks

- [ ] Out-of-order background events correct earlier aggregates.
- [ ] Out-of-order session ends close previously open activity.
- [ ] Late events do not require rebuilding all historical data.
- [ ] Corrections are reflected in the serving table.
- [ ] The chosen lateness boundary is justified.
- [ ] Events beyond the boundary are observable and not silently ignored.

---

# 9. Open Session and Incremental Update Validation

Open sessions keep evolving as new heartbeats arrive. This must be handled incrementally.

## 9.1 Required test sequence

Use one test session and insert incrementally.

### Batch 1

```text
12:00 VideoSessionStart
12:00 VideoPlay
12:01 VideoHeartbeat
```

Validate that the session is active only according to the documented timeout.

### Batch 2

```text
12:02 VideoHeartbeat
```

Validate that activity extends without duplicating earlier minutes.

### Batch 3

```text
12:03 AppBackgrounded
```

Validate that activity stops at 12:03.

### Batch 4

```text
12:05 AppForegrounded
12:05 VideoPlay
12:06 VideoHeartbeat
```

Validate that a new active interval begins.

### Batch 5

```text
12:07 VideoSessionEnd
```

Validate finalization.

### Checks

- [ ] Each batch updates only affected session/time buckets.
- [ ] Existing unaffected history is not fully rebuilt.
- [ ] Earlier minutes are not double-counted.
- [ ] The latest heartbeat extends activity correctly.
- [ ] Backgrounding closes activity immediately.
- [ ] Foreground/resume creates a new interval correctly.
- [ ] Session end finalizes the session.
- [ ] Query results become visible within the stated freshness SLA.

### Evidence to capture

- Insert timestamp
- Aggregate visible timestamp
- Refresh latency
- Parts created
- Rows written
- Query log/traces
- Before/after concurrency values

---

# 10. Minute-Level Concurrency Correctness

The model must answer concurrency by minute without scanning all raw session history for every query.

## 10.1 Basic synthetic scenario

Events:

```text
Session A: active 10:00–10:03
Session B: active 10:01–10:04
Session C: active 10:02–10:03
```

Expected result:

| Minute | Expected concurrency |
|---|---:|
| 10:00 | 1 |
| 10:01 | 2 |
| 10:02 | 3 |
| 10:03 | Depends on documented boundary convention |
| 10:04 | 0 |

Document interval convention:

- [ ] `[start, end)`
- [ ] `(start, end]`
- [ ] Other:

The recommended convention is normally `[start, end)` to avoid counting a viewer in two adjacent intervals at the same boundary.

## 10.2 Background exclusion scenario

```text
10:00 VideoPlay
10:01 VideoHeartbeat
10:02 AppBackgrounded
10:05 AppForegrounded
10:05 VideoPlay
10:06 VideoHeartbeat
10:07 VideoSessionEnd
```

Expected:

- Active before backgrounding.
- Not active from `10:02` to `10:05`.
- Active again only after the documented resume condition.
- Inactive after session end.

### Checks

- [ ] Minute concurrency matches hand-calculated test fixtures.
- [ ] Boundary behavior is consistent.
- [ ] Background time is excluded.
- [ ] Stale-heartbeat time is excluded.
- [ ] No negative concurrency occurs.
- [ ] No session contributes more than once in the same bucket.
- [ ] Empty buckets return `0` where needed by the dashboard.

---

# 11. Peak Concurrency Validation

Peak concurrency is the maximum minute-level concurrency within the requested range **after applying the requested dimension filters**.

Example:

| Minute | Concurrency |
|---|---:|
| Minute 1 | 300,000 |
| Minute 2 | 200,000 |
| Minute 3 | 50,000 |

Expected peak: `300,000`.

### Important validation

The implementation must not calculate a global peak first and then apply dimensions incorrectly. Different dimension combinations can peak at different minutes.

### Query template

```sql
SELECT
    platform,
    country,
    content_id,
    max(concurrency) AS peak_concurrency,
    argMax(minute, concurrency) AS peak_minute
FROM <database>.<minute_serving_table>
WHERE minute >= <from_time>
  AND minute < <to_time>
GROUP BY
    platform,
    country,
    content_id
ORDER BY peak_concurrency DESC;
```

### Checks

- [ ] Peak is calculated over minute-level values.
- [ ] Filters are applied before peak aggregation.
- [ ] Peak can be grouped independently by platform.
- [ ] Peak can be grouped independently by country.
- [ ] Peak can be grouped independently by content.
- [ ] Peak supports combinations such as platform + country.
- [ ] `argMax`/peak timestamp is deterministic during ties or tie behavior is documented.
- [ ] Peak query reads the serving layer, not all raw events.

---

# 12. Average Concurrency Validation

The team must document what “average concurrency” means.

Possible definitions:

1. Average of minute-level concurrency values.
2. Time-weighted average over a range.
3. Average over only populated minutes.
4. Average including zero-concurrency minutes.

Selected definition:

```text
________________________________________________________
```

### Recommended query pattern

```sql
SELECT
    avg(concurrency) AS average_concurrency
FROM <database>.<minute_serving_table>
WHERE minute >= <from_time>
  AND minute < <to_time>
  AND <dimension filters>;
```

### Checks

- [ ] Average definition is documented.
- [ ] Zero-concurrency minutes are handled intentionally.
- [ ] Partial first/last buckets are handled intentionally.
- [ ] Average matches manual test fixtures.
- [ ] Average supports the same filters as peak.
- [ ] Hour/day averages are derived consistently.
- [ ] Integer truncation does not corrupt results.

---

# 13. Dimension and Filter Validation

Required business dimensions include at least:

- `platform`
- `country`
- `content_id`
- `title`
- `video_type`
- Time grain

Additional source dimensions:

- `app_version`
- `audio_language`
- `subtitle_language`
- `player_version`
- `category`

## 13.1 Filter matrix

| Filter combination | Correct result? | Uses serving layer? | Latency | Rows read | Notes |
|---|---:|---:|---:|---:|---|
| Time only | [ ] | [ ] | | | |
| Platform | [ ] | [ ] | | | |
| Country | [ ] | [ ] | | | |
| Content ID | [ ] | [ ] | | | |
| Video type | [ ] | [ ] | | | |
| Platform + country | [ ] | [ ] | | | |
| Platform + content | [ ] | [ ] | | | |
| Country + content | [ ] | [ ] | | | |
| Platform + country + content | [ ] | [ ] | | | |
| Category + video type | [ ] | [ ] | | | |
| App version | [ ] | [ ] | | | |

### Checks

- [ ] Metadata filters do not require a costly raw-event join on every dashboard request.
- [ ] Unknown metadata values remain queryable.
- [ ] Filters do not multiply counts due to duplicate metadata.
- [ ] `ORDER BY` aligns reasonably with common filters.
- [ ] Adding a new dimension has a documented trade-off.
- [ ] The team can explain why not every dimension should necessarily be materialized in every table.

---

# 14. Time Grain Validation

Required benchmark grains include minute, hour, and day.

| Grain | Query works? | Correct? | Source table | Latency | Notes |
|---|---:|---:|---|---:|---|
| Minute | [ ] | [ ] | | | |
| Hour | [ ] | [ ] | | | |
| Day | [ ] | [ ] | | | |

### Checks

- [ ] Hourly peak is the maximum of underlying minute concurrency, not the sum of minute peaks.
- [ ] Daily peak is the maximum of underlying minute/hour values according to the chosen model.
- [ ] Hourly average uses a documented weighting rule.
- [ ] Daily average uses a documented weighting rule.
- [ ] Timezone and day boundaries are documented.
- [ ] Daylight-saving behavior is documented if non-UTC business time is supported.

---

# 15. Serving Layer Validation

A dashboard-grade serving table is expected. Dashboard queries should not repeatedly reconstruct all intervals from raw history.

### Serving table inventory

| Table | Grain | Dimensions | Engine | Update method | Retention |
|---|---|---|---|---|---|
| | | | | | |

### Checks

- [ ] Dashboard reads a dedicated aggregate/serving layer.
- [ ] Serving rows are continuously updated.
- [ ] Open sessions can revise affected buckets.
- [ ] Late events can revise affected buckets.
- [ ] Finalized history can be compacted.
- [ ] The table does not unnecessarily explode all raw sessions into all possible dimension combinations.
- [ ] Negative delta and positive delta events reconcile correctly if an interval-to-delta model is used.
- [ ] Final concurrency never becomes negative.
- [ ] Query logic does not depend on background merges completing immediately.
- [ ] `FINAL` is not required on every production-style dashboard query, or its cost is measured and justified.

---

# 16. Materialized View Validation

For every materialized view:

```sql
SHOW CREATE TABLE <database>.<materialized_view>;
SHOW CREATE TABLE <database>.<destination_table>;
```

| Materialized view | Source | Destination | Correct columns? | Duplicate-safe? | Late-update-safe? |
|---|---|---|---:|---:|---:|
| | | | | | |

### Checks

- [ ] Materialized views process only inserted blocks as expected.
- [ ] The team does not incorrectly assume a materialized view automatically rereads updated source rows.
- [ ] Backfill procedure is documented.
- [ ] Rebuild procedure is documented.
- [ ] Destination engines match emitted aggregate states.
- [ ] Aggregate-state columns use matching `AggregateFunction` types where relevant.
- [ ] `AggregatingMergeTree` queries correctly use `...Merge()` functions where required.
- [ ] `SummingMergeTree` is not used where non-additive metrics would become incorrect.
- [ ] Versioned/replacing tables have a deterministic version column.
- [ ] Collapsing tables maintain balanced signs and do not expose incorrect intermediate results.

---

# 17. Content Enrichment Validation

The integration goal requires events to be enriched with content metadata.

### Checks

- [ ] Join key is `content_id`.
- [ ] Join type is documented.
- [ ] Missing content metadata does not drop valid playback events unintentionally.
- [ ] Duplicate content rows do not multiply playback rows.
- [ ] Enrichment occurs at ingestion, aggregation, dictionary lookup, or serving using a documented approach.
- [ ] Join consistency is tested.
- [ ] Content title, video type, and category can be filtered.
- [ ] Content updates have a defined historical behavior:
  - [ ] Keep metadata as known at event time
  - [ ] Use latest metadata
  - [ ] Other:

### Unmatched-content query

```sql
SELECT
    count() AS event_rows,
    uniqExact(r.content_id) AS unmatched_content_ids
FROM <database>.<raw_events_table> AS r
LEFT JOIN <database>.<content_table> AS c
    ON r.content_id = c.content_id
WHERE c.content_id IS NULL;
```

---

# 18. Performance Validation

Judges evaluate latency **and what the query reads**.

## 18.1 Capture query metrics

Use `system.query_log`.

```sql
SYSTEM FLUSH LOGS;

SELECT
    event_time,
    query_duration_ms,
    read_rows,
    formatReadableSize(read_bytes) AS read_size,
    result_rows,
    memory_usage,
    query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 30 MINUTE
  AND query ILIKE '%<serving_table>%'
ORDER BY event_time DESC
LIMIT 100;
```

## 18.2 Benchmark table

Run each query cold and warm multiple times.

| Query | Filters | Range | Cold ms | Warm p50 ms | Warm p95 ms | Rows read | Bytes read | Memory |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Minute trend | None | 1 hour | | | | | | |
| Minute trend | Platform | 1 hour | | | | | | |
| Peak | Platform + country | 1 day | | | | | | |
| Average | Content | 1 day | | | | | | |
| Hourly | Video type | 7 days | | | | | | |
| Daily | None | Full dataset | | | | | | |

### Checks

- [ ] Queries run at dashboard-grade latency.
- [ ] Latency is measured, not guessed.
- [ ] Rows and bytes read are recorded.
- [ ] Common queries do not scan the full raw events table.
- [ ] Query plans are inspected using `EXPLAIN`.
- [ ] Partition pruning works.
- [ ] Primary-key/order-key pruning works.
- [ ] Performance is tested with realistic filters.
- [ ] Performance evidence includes ClickHouse service size.
- [ ] Results are stable after merges and restarts.

### Explain queries

```sql
EXPLAIN indexes = 1
SELECT ...;

EXPLAIN PIPELINE
SELECT ...;
```

---

# 19. Scale and Storage Validation

The sample is a small proxy for a much larger production workload.

### Required design explanation

| Topic | Team explanation |
|---|---|
| Behavior at 10× events | |
| Behavior at 100× events | |
| Storage growth | |
| Number of rows per session | |
| Number of rows per active interval | |
| Number of serving rows per minute | |
| Effect of adding dimensions | |
| Merge pressure | |
| Mutation/update strategy | |
| Backfill strategy | |
| Retention/tiering strategy | |

### Checks

- [ ] No full historical rescan is needed for each dashboard query.
- [ ] No full rebuild is needed for every heartbeat.
- [ ] The model avoids unbounded state for abandoned sessions.
- [ ] High-cardinality dimensions are handled intentionally.
- [ ] The team estimates row growth and disk growth.
- [ ] The team explains merge behavior at 100× scale.
- [ ] The design does not rely on frequent large ClickHouse mutations.
- [ ] Recent and historical data can be tiered if using a hybrid design.

---

# 20. ClickStack, Langfuse, or LibreChat Integration

At least one integration must be meaningful.

Select implemented integration:

- [ ] ClickStack
- [ ] Langfuse
- [ ] LibreChat
- [ ] More than one
- [ ] Not implemented

## 20.1 ClickStack validation

- [ ] Ingestion lag is visible.
- [ ] Query latency is visible.
- [ ] Failed inserts are visible.
- [ ] Late-event counts are visible.
- [ ] Duplicate-event counts are visible.
- [ ] Open-session count is visible.
- [ ] Pipeline alerts or diagnostic views are useful.
- [ ] It is connected to the actual concurrency pipeline, not sample-only telemetry.

## 20.2 LibreChat validation

- [ ] Connected through ClickHouse MCP or an equivalent real query path.
- [ ] Can answer peak concurrency by filter.
- [ ] Can answer average concurrency by filter.
- [ ] Generated SQL is visible or auditable.
- [ ] Queries use the serving layer.
- [ ] Unsafe or unconstrained full scans are prevented.
- [ ] Answers include time range and dimensions.

## 20.3 Langfuse validation

- [ ] Real LLM/MCP calls are traced.
- [ ] Prompt, generated query, latency, and result metadata are captured.
- [ ] The integration helps evaluate or debug the conversational analytics layer.
- [ ] It is not presented as part of core concurrency correctness unless actually involved.

### Overall check

- [ ] The integration provides operational or analytical value.
- [ ] The integration can be demonstrated live.
- [ ] Removing it would remove a real capability, not only branding.

---

# 21. Representative OTT Test Scenarios

Run all scenarios through the actual pipeline.

| ID | Scenario | Expected behavior | Status |
|---|---|---|---|
| T01 | Normal play with regular heartbeats and end | Count active until end | NOT TESTED |
| T02 | Session starts but never plays | Do not count unless rule explicitly says otherwise | NOT TESTED |
| T03 | Play, background, foreground, resume | Exclude background interval | NOT TESTED |
| T04 | Background event missing, heartbeat stops | Stop after heartbeat timeout | NOT TESTED |
| T05 | Foreground event missing, heartbeat resumes | Follow documented recovery rule | NOT TESTED |
| T06 | Duplicate heartbeat | No concurrency increase | NOT TESTED |
| T07 | Duplicate start event | Session still counts once | NOT TESTED |
| T08 | Events inserted out of order | Event-time result remains correct | NOT TESTED |
| T09 | Late background event | Previously counted interval corrected | NOT TESTED |
| T10 | Late session end | Open interval corrected/finalized | NOT TESTED |
| T11 | Session remains open at day end | Incrementally maintained with timeout/watermark | NOT TESTED |
| T12 | Video error during play | Stop according to documented rule | NOT TESTED |
| T13 | Same user with two valid sessions | Session concurrency may be 2; user concurrency rule documented | NOT TESTED |
| T14 | One session changes content unexpectedly | Behavior rejected or documented | NOT TESTED |
| T15 | Unknown content ID | Event retained and measurable | NOT TESTED |
| T16 | Two events at identical timestamp | Deterministic event precedence | NOT TESTED |
| T17 | Cross-midnight session | Correct date/time buckets | NOT TESTED |
| T18 | Very long abandoned session | Timeout prevents indefinite counting | NOT TESTED |
| T19 | Replayed source batch | Final result unchanged | NOT TESTED |
| T20 | New unseen-day file | Pipeline runs without schema-specific manual edits | NOT TESTED |

---

# 22. Session Concurrency vs User Concurrency

The source data supports both session-level and user-level interpretations.

### Required decision

- Primary metric:
  - [ ] Concurrent sessions
  - [ ] Concurrent users
  - [ ] Both

### Checks

- [ ] The dashboard labels the metric accurately.
- [ ] Multiple sessions from one user are handled according to the chosen metric.
- [ ] Anonymous/missing users do not break session concurrency.
- [ ] The implementation does not accidentally use `uniq(user_id)` when judges expect sessions.
- [ ] Session-aware and user-aware results are not mixed.

---

# 23. Data Quality Validation

```sql
SELECT
    countIf(video_session_id = '' OR video_session_id IS NULL) AS missing_session,
    countIf(content_id IS NULL) AS missing_content,
    countIf(event_timestamp IS NULL) AS missing_timestamp,
    countIf(event_type = '' OR event_type IS NULL) AS missing_event_type
FROM <database>.<raw_events_table>;
```

### Checks

- [ ] Missing required IDs are counted.
- [ ] Invalid timestamps are counted.
- [ ] Unknown event types are counted.
- [ ] Events before session start are detected.
- [ ] Events after session end are detected.
- [ ] Sessions with multiple starts are detected.
- [ ] Sessions with multiple ends are detected.
- [ ] Impossible state transitions are detected.
- [ ] Data-quality exceptions are surfaced through observability or audit tables.

---

# 24. Pipeline Reproducibility and Unseen-Day Readiness

The unseen evaluation data must run through the same pipeline with evidence.

### Required runbook

- [ ] One command or documented sequence loads a fresh raw file.
- [ ] One command or documented sequence loads content metadata.
- [ ] Database objects can be recreated from version-controlled SQL.
- [ ] Backfill order is documented.
- [ ] Materialized views can be safely paused/recreated if needed.
- [ ] The pipeline does not depend on manually edited timestamps or IDs.
- [ ] Benchmark queries are stored in version control.
- [ ] Query outputs can be exported.
- [ ] Query latencies can be exported.
- [ ] Query logs/traces prove results came through the pipeline.
- [ ] Failures are detectable.
- [ ] Re-running the pipeline is idempotent.

### Evidence checklist

- [ ] DDL files
- [ ] Data loading scripts
- [ ] Materialized view definitions
- [ ] Benchmark SQL
- [ ] Test fixtures
- [ ] Expected test outputs
- [ ] Query log export
- [ ] Performance report
- [ ] Architecture diagram
- [ ] Design trade-off document
- [ ] Demo instructions

---

# 25. Demo Validation

Expected demonstration:

1. Replay a live-event day.
2. Show events arriving.
3. Show concurrency curve building in near real time.
4. Show an open session extending through heartbeats.
5. Show backgrounding reducing concurrency.
6. Apply platform filter.
7. Apply country filter.
8. Apply content/video-type filter.
9. Show peak and average concurrency.
10. Show query latency and rows scanned.
11. Show ClickStack/Langfuse/LibreChat integration.
12. Explain how late events revise results.

### Checks

- [ ] Demo uses the actual ClickHouse pipeline.
- [ ] No values are hardcoded in the UI.
- [ ] Minimal UI is sufficient; correctness and serving design remain central.
- [ ] Demo queries use the serving table.
- [ ] Dashboard refresh delay is stated.
- [ ] Failure or lag visibility is included.

---

# 26. Critical Failure Conditions

Mark the implementation **FAIL** if any of these are true:

- [ ] It counts every session from start to end regardless of background state.
- [ ] It counts stale sessions indefinitely after heartbeats stop.
- [ ] It scans all raw session history for every dashboard query.
- [ ] It rebuilds all historical aggregates for every new heartbeat.
- [ ] Duplicate events inflate concurrency.
- [ ] Out-of-order events produce permanently wrong results.
- [ ] Open sessions cannot update already served results.
- [ ] Peak is calculated incorrectly across dimensions.
- [ ] Average concurrency has no documented definition.
- [ ] The serving table cannot filter by required dimensions.
- [ ] The implementation works only for the supplied day and needs manual tuning for a new day.
- [ ] ClickHouse is not the primary computation engine.
- [ ] Required external integration is superficial or absent.
- [ ] There is no query/pipeline evidence for produced results.

---

# 27. Scoring Rubric

Suggested internal score out of 100.

| Category | Weight | Score |
|---|---:|---:|
| Foreground-only correctness | 25 | |
| Heartbeat and timeout correctness | 10 | |
| Late/duplicate/out-of-order handling | 10 | |
| Open-session incremental updates | 10 | |
| Peak and average correctness | 10 | |
| Filter and time-grain support | 10 | |
| Serving-layer query performance | 10 | |
| ClickHouse schema/design quality | 5 | |
| 100× scalability explanation | 5 | |
| ClickStack/Langfuse/LibreChat integration | 3 | |
| Reproducibility and pipeline evidence | 2 | |
| **Total** | **100** | |

### Suggested interpretation

| Score | Result |
|---:|---|
| 90–100 | Strong submission |
| 75–89 | Mostly correct; targeted improvements needed |
| 60–74 | Partial solution; important risks remain |
| Below 60 | Major redesign or correctness work needed |

> A solution should not receive a passing internal review if foreground/background or heartbeat-gap correctness fails, regardless of its total score.

---

# 28. Execution Review Notes

## What was implemented well

1.
2.
3.

## Incorrect or risky implementation

1.
2.
3.

## Missing requirements

1.
2.
3.

## Performance findings

1.
2.
3.

## Required fixes before submission

| Priority | Fix | Owner | Due date | Status |
|---|---|---|---|---|
| P0 | | | | |
| P1 | | | | |
| P2 | | | | |

---

# 29. Final Sign-Off

### Reviewer conclusion

```text
[ ] APPROVED
[ ] APPROVED WITH CONDITIONS
[ ] REWORK REQUIRED
[ ] REJECTED
```

### Conclusion notes

```text
________________________________________________________

________________________________________________________

________________________________________________________
```

### Sign-off

| Role | Name | Date | Signature/Approval |
|---|---|---|---|
| Implementer | | | |
| Reviewer | | | |
| Team lead | | | |

---

# Appendix A — Minimum SQL Evidence to Collect

Ask the implementer to provide outputs for:

```sql
SHOW CREATE TABLE <raw_events_table>;
SHOW CREATE TABLE <content_table>;
SHOW CREATE TABLE <session_aware_table>;
SHOW CREATE TABLE <session_independent_table>;
SHOW CREATE TABLE <minute_serving_table>;
SHOW CREATE TABLE <each_materialized_view>;
```

Also collect:

```sql
SELECT version();

SELECT database, name, engine, total_rows, total_bytes
FROM system.tables
WHERE database = '<database>';

SELECT *
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 1 HOUR
ORDER BY event_time DESC
LIMIT 100;
```

For each benchmark query collect:

- SQL text
- Result
- Query duration
- Read rows
- Read bytes
- Memory usage
- Query plan
- Filters used
- Source table used
- Screenshot or trace evidence

---

# Appendix B — Questions to Ask the Implementer

1. What exact event starts an active interval?
2. What exact event closes an active interval?
3. What heartbeat timeout did you choose, and why?
4. What happens when `AppBackgrounded` is missing?
5. What happens when `AppForegrounded` is missing?
6. What happens when a heartbeat arrives late?
7. How do you deduplicate repeated events?
8. How do you correct already published minute aggregates?
9. How do you represent an open session?
10. What prevents one session from being counted twice?
11. How do you calculate peak concurrency for each dimension combination?
12. What exact definition do you use for average concurrency?
13. Which table does the dashboard query?
14. How many rows and bytes does a one-day filtered query read?
15. What changes at 100× data volume?
16. What happens when a new dimension is added?
17. How do you replay a fresh unseen-day file?
18. How do you prove results came through the pipeline?
19. What operational value does ClickStack, Langfuse, or LibreChat provide?
20. Which trade-off in your design would you change with more time?

---

# Appendix C — Source Requirements Covered

This checklist covers the following SonyLIV requirements:

- ClickHouse as primary ingestion, modeling, and analytical engine.
- Foreground-only concurrency.
- Heartbeat and active-state processing.
- Background-period exclusion.
- Session-aware and session-independent approaches.
- Content enrichment.
- Duplicate and late-event handling.
- Continuously updated aggregates.
- Minute/hour/day peak and average concurrency.
- Platform, country, content, video-type, and time filters.
- Open-session incremental updates.
- Dedicated dashboard-serving layer.
- Dashboard-grade query latency.
- Scale behavior beyond the sample dataset.
- Meaningful ClickStack, Langfuse, or LibreChat integration.
- Pipeline evidence and unseen-day reproducibility.
