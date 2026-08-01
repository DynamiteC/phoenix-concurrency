# SonyLIV Click-a-thon 2026: Implementation Validation Checklist

> **Purpose:** Use this document to validate whether the ClickHouse implementation created by a team member correctly satisfies the SonyLIV foreground-only concurrency problem statement.
>
> **Validation status values:** `PASS`, `FAIL`, `PARTIAL`, `NOT TESTED`
>
> **Important:** A table existing is not enough. The implementation must prove correctness, incremental update handling, query performance, filter support, and pipeline reproducibility.

**This copy is filled in.** Every value below was produced by a live query against the
service during the validation run. Nothing is carried over from documentation or prose.

| Field | Value |
|---|---|
| Validated by | automated review pass |
| Validation date | 2026-08-01 |
| Service | ClickHouse Cloud `26.2.1.525`, ap-south-1 |
| Database | `phoenix` |
| Scope predicate | `event_timestamp < '2026-08-01'`, the frozen validated corpus |

Rows dated 2026-08-01 share `raw_events` with the validated corpus, so every correctness
number below is scoped by that predicate. The two slices share zero `video_session_id`
values, so the cut is clean.

**On the real-time slice.** Those 55,293 rows are **manually ingested**: an operator runs
the load, there is no autonomous producer attached to the pipeline. This matters for how
several findings below should be read. Arrival timing is operator-controlled rather than
observed, so anything the checklist asks about arrival behavior (freshness SLA, lateness
distribution, ingestion lag) is currently a property of the demo procedure, not of a
measured system. The pipeline's handling of those events is genuinely correct and proven;
what is not yet evidenced is how the system behaves under an arrival pattern nobody is
driving by hand.

---

## 1. Validation Summary

| Area | Status | Evidence / Notes |
|---|---|---|
| Raw event ingestion | PASS | 905,558 rows loaded = 905,559 CSV lines minus header, exact |
| Content metadata ingestion | PASS | 33,464 rows = 33,465 lines minus header, 0 duplicate `content_id` |
| Schema matches source datasets | PASS | all 13 source columns present and typed, epoch millis to `DateTime64(3)` |
| Event-to-content enrichment | PASS | LEFT JOIN on `content_id`, 0 unmatched event rows |
| Duplicate event handling | PASS | 4,210 excess duplicate rows in source, collapsed by `(session, ms)` before state |
| Late-arriving event handling | PARTIAL | event time throughout, additive corrections proven, no stated lateness boundary (ingest is manual, so no arrival data exists to set one) |
| Foreground/background state logic | PASS | oracle parity 3,664 minutes, 0 diffs |
| Heartbeat-gap handling | PASS | every segment capped at `ts + tolerance_s`, default 90s |
| Session-aware aggregation | PASS | max 1 run per session-minute, measured |
| Session-independent aggregation | PASS | separate user rollup, 3,664 minutes, 0 diffs vs oracle |
| Open-session incremental updates | PASS | 5,316 minutes, 0 diffs vs one-pass batch truth |
| Minute concurrency serving table | PASS | `concurrency_deltas`, 26,904 rows |
| Peak concurrency queries | PASS | filter-aware, computed after filtering, peak 2,829 at 10:56 |
| Average concurrency queries | **FAIL** | both shipped queries over-report, 2.81x and 2.12x measured |
| Dimension filters | PASS | all required dimensions filterable, filters prune reads |
| Hour/day aggregation | PASS | grain 60 / 3600 / 86400 all correct, hour peak = max of its minutes |
| Query latency | PASS | 8-9 ms across every filter shape |
| Rows/bytes scanned | PASS | 8,192-26,904 rows, 0 serving queries touch `raw_events` |
| 100x scalability explanation | PARTIAL | reasoning lives in SQL comments, no written design doc |
| ClickStack/Langfuse/LibreChat integration | **FAIL** | not implemented, no code, config, or endpoint in the repo |
| Pipeline evidence and reproducibility | PASS | `evidence/LEDGER.tsv`, 6 artifacts, all scripts version-controlled |

### Final result

- **Overall status:** `APPROVED WITH CONDITIONS`
- **Critical failures:**
  1. Average concurrency is computed over the wrong denominator in both serving queries.
  2. The required external integration is absent. Section 26 lists this as a standalone
     FAIL condition.
- **Major risks:**
  1. No documented maximum lateness or watermark, so no bucket is ever formally final.
  2. **Ingestion of the real-time slice is manual.** Every arrival-side claim (freshness,
     ingestion lag, lateness) is therefore a property of the demo procedure rather than a
     measured system. Say this before a judge infers otherwise.
  3. `evidence/LEDGER.tsv` carries an unresolved `FAIL` row (`naive_baseline_gate`).
  4. 42% of stored intervals are zero-length, which fails a literal reading of the
     interval invariant even though minute-grain output is provably correct.
- **Recommended fixes:** see the P0/P1/P2 table in section 28.
- **Validated by:** automated review pass
- **Validation date:** 2026-08-01

---

# 2. Required Source Data

The implementation must load and use both datasets. Both are loaded.

## 2.1 Raw event dataset

| Column | Expected purpose | Present? | Correct type? | Notes |
|---|---|---:|---:|---|
| `video_session_id` | Unique video playback session | [x] | [x] | `String`, not coerced to numeric |
| `user_id` | User identifier | [x] | [x] | `String` |
| `content_id` | Content identifier and join key | [x] | [x] | `Int64`, matches `content.content_id` |
| `event_type` | Playback or application state event type | [x] | [x] | `LowCardinality(String)` |
| `event` | Actual event value | [x] | [x] | `LowCardinality(String)`, 49 distinct values |
| `event_timestamp` | Event-time timestamp | [x] | [x] | `DateTime64(3)`, millisecond precision retained |
| `platform` | Filter dimension | [x] | [x] | `LowCardinality(String)`, 12 values |
| `app_version` | Filter dimension | [x] | [x] | `LowCardinality(String)` |
| `country` | Filter dimension | [x] | [x] | `LowCardinality(String)`, 5 values |
| `audio_language` | Filter dimension | [x] | [x] | present in raw, not carried to serving |
| `subtitle_language` | Filter dimension | [x] | [x] | present in raw, not carried to serving |
| `player_version` | Filter dimension | [x] | [x] | present in raw, not carried to serving |
| `session_start_epoch` | Session start time | [x] | [x] | `DateTime64(3)` |

Expected `event_type` values, all seven present:

| `event_type` | Rows | Distinct `event` values |
|---|---:|---:|
| `VideoHeartbeat` | 843,600 | 41 |
| `AppBackgrounded` | 14,700 | 1 |
| `AppForegrounded` | 14,321 | 1 |
| `VideoPlay` | 10,883 | 1 |
| `VideoSessionEnd` | 10,881 | 1 |
| `VideoSessionStart` | 10,880 | 1 |
| `VideoError` | 293 | 1 |

### Validation queries

```sql
DESCRIBE TABLE phoenix.raw_events;

SELECT
    event_type,
    count() AS rows
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01'
GROUP BY event_type
ORDER BY rows DESC;

SELECT
    count() AS total_rows,
    uniqExact(video_session_id) AS sessions,
    uniqExact(user_id) AS users,
    uniqExact(content_id) AS contents,
    min(event_timestamp) AS first_event,
    max(event_timestamp) AS last_event
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01';
```

Result:

| Metric | Frozen corpus | Whole table |
|---|---:|---:|
| Rows | 905,558 | 960,851 |
| Sessions | 10,866 | 12,412 |
| Users | 9,618 | 11,164 |
| Contents | 3,357 | 3,362 |
| First event | 2026-07-14 15:43:58.144 | 2026-07-14 15:43:58.144 |
| Last event | 2026-07-26 11:30:04.847 | 2026-08-01 13:20:21.559 |

### Checks

- [x] Approximately the expected raw event volume was loaded. Exactly, in fact: 905,558.
- [x] No source columns were silently dropped. All 13 present.
- [x] `event_timestamp` is stored as `DateTime64(3)`.
- [x] Timezone handling is documented. `--session_timezone UTC` is pinned in `scripts/ch.sh`
      on every call, because local runs are Asia/Kolkata and the service is UTC.
- [x] `content_id` type matches the content metadata table. `Int64` on both sides.
- [x] Session and user IDs are not lossily converted. Both remain `String`.
- [x] Raw data remains available for debugging and replay. `raw_events` is append-only and
      never read by a dashboard.
- [x] Source-row count and loaded-row count were compared. `wc -l` gives 905,559 lines,
      minus the header is 905,558, matching the loaded count exactly.

---

## 2.2 Content metadata dataset

| Column | Expected purpose | Present? | Correct type? | Notes |
|---|---|---:|---:|---|
| `content_id` | Join key | [x] | [x] | `Int64` |
| `title` | Filter/display dimension | [x] | [x] | `String`, not carried to serving |
| `video_type` | Filter dimension | [x] | [x] | `LowCardinality(String)`, carried to serving |
| `category` | Filter dimension | [x] | [x] | `LowCardinality(String)`, not carried to serving |

### Validation queries

```sql
DESCRIBE TABLE phoenix.content;

SELECT count() AS total_rows, uniqExact(content_id) AS unique_content_ids
FROM phoenix.content;

SELECT content_id, count() AS duplicate_count
FROM phoenix.content
GROUP BY content_id
HAVING duplicate_count > 1
ORDER BY duplicate_count DESC
LIMIT 100;
```

Result: 33,464 rows, 33,464 unique `content_id`, **0 duplicate ids**. The CSV has 33,465
lines, so the header accounts for the difference exactly.

### Checks

- [x] Approximately the expected content volume was loaded.
- [x] `content_id` is unique. Proven, so no duplicate-handling logic is required.
- [x] Content metadata is available during aggregation, joined in `01_derive_intervals.sql`.
- [x] Unknown/unmatched content IDs are measurable. The measured count is 0.
- [x] Metadata cannot multiply event rows. Uniqueness proven above.

Note on the engine: `content` is `ReplacingMergeTree` ordered by `content_id`, so a future
reload with changed metadata replaces rather than duplicates.

---

# 3. ClickHouse Table Architecture

| Object | Type/Engine | Purpose | Source | Destination/Consumer | Status |
|---|---|---|---|---|---|
| `raw_events` | SharedMergeTree | append-only source of truth, 960,851 rows | `raw_events_mv` | `event_state` | PASS |
| `raw_events_landing` | Null | CSV-shaped landing, pass-through | `load.sh` | `raw_events_mv` | PASS |
| `raw_events_mv` | MaterializedView | epoch millis to `DateTime64(3)` | `raw_events_landing` | `raw_events` | PASS |
| `content` | SharedReplacingMergeTree | metadata, 33,464 rows | `load.sh` | interval derivation | PASS |
| `event_state` | View | the state machine, single definition | `raw_events` | both derivation paths | PASS |
| `foreground_intervals` | SharedMergeTree | active intervals, 631,103 rows | `01_derive_intervals.sql` | `02_merge_runs.sql` | PASS |
| `session_minute_runs` | SharedCollapsingMergeTree | minute runs, retractable, 25,197 rows | `02_merge_runs.sql` | `concurrency_deltas_mv` | PASS |
| `concurrency_deltas` | SharedSummingMergeTree | session serving layer, 26,904 rows | `concurrency_deltas_mv` | dashboard | PASS |
| `concurrency_deltas_mv` | MaterializedView | run to +1/-1 pair | `session_minute_runs` | `concurrency_deltas` | PASS |
| `user_minute_runs` | SharedCollapsingMergeTree | user runs merged across sessions, 18,145 rows | `04_merge_user_runs.sql` | `user_concurrency_deltas_mv` | PASS |
| `user_concurrency_deltas` | SharedSummingMergeTree | user serving layer, 29,369 rows | `user_concurrency_deltas_mv` | dashboard | PASS |
| `user_concurrency_deltas_mv` | MaterializedView | run to +1/-1 pair | `user_minute_runs` | `user_concurrency_deltas` | PASS |
| `concurrency_deltas_naive` | SharedSummingMergeTree | naive baseline for comparison, 15,725 rows | validation only | evidence | PASS |
| `open_test_sessions`, `open_test_bystanders` | SharedMergeTree | open-session test fixtures, 30 and 200 rows | test harness | evidence | PASS |

### Inventory queries

```sql
SELECT database, name, engine, total_rows, total_bytes
FROM system.tables
WHERE database = 'phoenix'
ORDER BY name;

SELECT database, table, partition, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS disk_size
FROM system.parts
WHERE active AND database = 'phoenix'
GROUP BY database, table, partition
ORDER BY table, partition;
```

### Checks

- [x] Raw ingestion table exists.
- [x] Content metadata table exists. A dictionary was tried and deliberately rejected:
      on Cloud, `dictGet` returned `''` for keys that provably exist and `dictHas` said 0
      while an INNER JOIN matched all 3,357 ids, because dictionaries load per replica and
      the answer depended on which node served the query. A JOIN against 33K rows costs
      nothing and is deterministic. This is the right call and it is documented in the DDL.
- [x] Enriched event layer exists / enrichment strategy is clearly implemented.
- [x] Session-aware state/interval layer exists.
- [x] Session-independent layer exists and is a genuinely separate rollup.
- [x] A dashboard-facing serving table exists.
- [x] Materialized views have valid source and destination tables.
- [x] No materialized view points to the wrong schema or database. Verified against
      `system.query_views_log`: every entry is `QueryFinish`, zero exceptions.
- [x] Table engines are justified. Collapsing for retractable runs, Summing for additive
      deltas, Null for a pure pass-through landing table.
- [x] `ORDER BY` keys support real query filters. See the deliberate inversion below.
- [x] Partitioning is based on a useful time boundary: `toYYYYMMDD(event_timestamp)`.
- [x] High-cardinality dimensions are not placed blindly in every aggregation key.
      `title`, `audio_language`, `subtitle_language`, `player_version`, and `category` are
      deliberately left out of the serving layer.
- [x] Nullable/default values are intentionally handled.
- [ ] Retention/TTL decisions are documented if used. **No TTL configured and none
      documented.** At this data size it does not bite, but it is a gap for a 100x story.

**The key inversion, and why it is correct.** `concurrency_deltas` is ordered
`(platform, country, video_type, content_id, app_version, minute)`, putting dimensions first
and `minute` last. This inverts the usual reflex on purpose. A cumulative sum has to start at
the first minute of the series, never at the start of the queried range, so a time predicate
must not prune anything. A dimension filter is the only thing that can prune, so the
dimensions have to lead the key. The measured read costs in section 13 confirm the design
does exactly what it claims.

---

# 4. Foreground-Only Business Logic

This is the most important validation area, and it is the area the implementation is
strongest in.

An open session does not automatically count as active. Backgrounded, paused, stale,
errored, and heartbeat-missing time are all excluded, and each exclusion is justified by a
documented rule.

## 4.1 Required documented decisions

| Decision | Team implementation | Status | Notes |
|---|---|---|---|
| Which events start active playback? | `VideoSessionStart`, `VideoPlay`, `AppForegrounded`, and `resume` / `speed-resume` / `AdResume` | PASS | defined once, in `event_state` |
| Which events stop active playback? | `AppBackgrounded`, `VideoSessionEnd`, `VideoError`, and `pause` / `speed-pause` / `AdPause` | PASS | |
| Does `VideoSessionStart` count immediately? | Yes, classified as reactivating | PASS | |
| Does `VideoPlay` start/resume activity? | Yes | PASS | |
| Does `AppBackgrounded` stop activity immediately? | Yes, immediately | PASS | |
| Does `AppForegrounded` resume immediately or wait? | Immediately | PASS | documented ruling, not an accident |
| Does `VideoSessionEnd` close activity? | Yes | PASS | |
| Does `VideoError` close activity? | Yes | PASS | 293 events in corpus |
| What heartbeat gap marks a session inactive? | `tolerance_s`, default 90s. Every segment is capped at `ts + tol` regardless of the last state | PASS | silence is not evidence of watching |
| What is the session timeout? | The same `tolerance_s` cap. No separate abandoned-session timeout | PASS | sufficient, since the cap bounds every segment |
| How are missing background/foreground events handled? | Last decisive state carried forward across neutral rows, bounded by the tolerance cap | PASS | |
| How are out-of-order events handled? | Irrelevant by construction: all ordering is by `event_timestamp`, never arrival | PASS | |
| How are identical duplicate events handled? | Collapsed to one row per `(video_session_id, millisecond)` before any state is derived | PASS | |
| How are contradictory events resolved? | `min()` over the classification at the same millisecond, so a close beats an open | PASS | errs toward not counting unproven time |

**The decisive design point.** 41 of the 49 distinct `event` values under `VideoHeartbeat`
are classified **neutral** and cannot flip state. Treating them as reactivating, which any
"default to open" classification does, means a `pause` is cancelled by the very next
buffer-health or network-activity row, so paused time is counted as watching. Longer pauses
carry more telemetry, so the error grows with exactly the thing being excluded. An
unrecognised event value is neutral, never open, so a new event type promised by the data
dictionary cannot manufacture viewing time.

Millisecond rather than second collapse is also load-bearing: 29% of events share a second
with another event, and collapsing at second precision reads a pause and its resume in the
same second as "paused". Keeping milliseconds drops ambiguous pause/resume pairs from 2,887
to 381, and for those 381 the close wins.

### Mandatory checks

- [x] Backgrounded intervals are excluded.
- [x] Time after a missing/stale heartbeat is excluded.
- [x] Time after session end is excluded.
- [x] Time after an unrecovered video error is excluded.
- [x] Foregrounding does not incorrectly count playback that remains paused.
- [x] A session cannot contribute more than `1` at one instant. **Measured: the maximum
      number of runs covering any single session-minute is exactly 1.**
- [x] Repeated heartbeat rows do not multiply concurrency.
- [x] The active-state rule is written clearly enough to reproduce independently. The
      strongest possible proof of this exists: the oracle is an independent
      reimplementation that deliberately does not import the pipeline's classification, and
      it agrees at 0 diffs.

---

# 5. Session-Aware Model Validation

## 5.1 Representation

- [ ] Interval arrays per session
- [x] **One normalized row per active interval**, merged into minute runs, then into a delta model
- [ ] Session state snapshots
- [ ] Versioned session record
- [x] **Collapsing model** for the run layer (`sign = +1` asserts, `-1` retracts)
- [ ] Hybrid model
- [ ] Other

### Required interval properties

```sql
SELECT
    countIf(interval_end <  interval_start) AS strictly_backwards,
    countIf(interval_end =  interval_start) AS zero_length,
    countIf(interval_end >  interval_start) AS positive,
    count()                                 AS total
FROM phoenix.foreground_intervals
WHERE interval_start < '2026-08-01';
```

| Property | Count |
|---|---:|
| `interval_end < interval_start` | **0** |
| `interval_end = interval_start` | 253,590 |
| `interval_end > interval_start` | 345,547 |
| Total | 599,137 |

**On the 253,590 zero-length intervals.** `foreground_intervals` stores `DateTime`, which is
second resolution, so any segment shorter than a second truncates to a point. This is a
storage-precision artifact, not a logic error: `timeSlots(start, 0, 60)` still yields exactly
one minute, so the minute is covered correctly and the run merge deduplicates it. The
checklist's literal `active_start < active_end` requirement therefore reads as violated while
the minute-grain output is provably right.

Proof that it is right, at the level the metric is actually served:

```sql
-- overlapping runs within a session, after the merge
SELECT count() AS overlapping_runs FROM (
  SELECT video_session_id, run_start,
         lagInFrame(run_end) OVER (PARTITION BY video_session_id ORDER BY run_start) AS prev_end
  FROM phoenix.session_minute_runs FINAL
  WHERE run_start < '2026-08-01'
) WHERE prev_end >= run_start;

-- maximum runs covering any one session-minute
SELECT max(c) AS max_runs_per_session_minute FROM (
  SELECT video_session_id,
         arrayJoin(timeSlots(run_start, toUInt32(dateDiff('second', run_start, run_end)), 60)) AS m,
         count() AS c
  FROM phoenix.session_minute_runs FINAL
  WHERE run_start < '2026-08-01'
  GROUP BY video_session_id, m);
```

| Check | Result |
|---|---:|
| Overlapping runs per session after merge | **0** |
| Max runs covering one session-minute | **1** |

Recommendation: store intervals as `DateTime64(3)`, or state the point-interval convention
explicitly in the DDL, so a reviewer is not left to derive this under time pressure. Tracked
as P2 in section 28.

### Checks

- [x] Every active interval belongs to one session.
- [x] Active intervals do not extend before the session start. 0 events precede
      `session_start_epoch` in the corpus.
- [x] Active intervals do not extend after a known session end.
- [x] Background events split or close intervals correctly.
- [x] Heartbeat timeout closes stale intervals.
- [x] Open sessions are distinguishable from finalized sessions, by absence of
      `VideoSessionEnd`.
- [x] Late events can correct previously emitted intervals, via `sign = -1` retraction.
- [x] Corrections do not leave duplicate active intervals. 0 overlapping runs measured.
- [x] Reprocessing the same event batch is idempotent. Proven by the open-session test.

---

# 6. Session-Independent Model Validation

A genuinely separate rollup, not an alias. A user's runs are merged **across all of their
sessions** before any `+1` is emitted, so overlapping sessions collapse into one run first.
Deltas cannot be reused from the session rollup, because summing session deltas counts a
multi-device person twice.

| Metric | Sessions | Users |
|---|---:|---:|
| Peak concurrency | **2,829** | **2,749** |
| Minutes with data | 1,532 | 1,486 |
| Net delta sum (must be 0) | **0** | **0** |
| Minimum running concurrency (must be >= 0) | **0** | **0** |
| Oracle parity, batch | 3,664 minutes, 0 diffs | 3,664 minutes, 0 diffs |
| Oracle parity, incremental | 3,664 minutes, 0 diffs | 3,664 minutes, 0 diffs |

### Checks

- [x] A separate session-independent aggregate exists (`user_concurrency_deltas`).
- [x] It is not merely an alias of the session-aware table. Different row count (29,369 vs
      26,904), different peak, different minute count.
- [x] Its state transition logic is documented.
- [x] It correctly handles background and foreground events. Same `event_state` view.
- [x] It correctly handles heartbeat gaps.
- [x] Its concurrency can be compared at the same time grain and dimensions.
- [x] Differences between both approaches are measurable: peak 2,829 vs 2,749, an 80-viewer
      gap at peak.
- [x] The team can explain why differences occur: multi-device users. One person on a phone
      and a TV is two sessions and one viewer.

**Known trade-off, documented in the DDL.** A user is attributed to the dimensions of their
**first** run. 7 users of 9,510 watch on more than one platform, so a platform filter files
them under the platform they started on. Keying user runs by dimension instead would make the
unfiltered total wrong for exactly those users, which is the worse trade: the unfiltered
number is the one on the wall. A platform-filtered user number is therefore approximate for
those 7 users, and exact for the other 9,503.

### Comparison query

```sql
SELECT
    s.minute,
    s.concurrency AS session_aware,
    u.concurrency AS session_independent,
    session_independent - session_aware AS difference
FROM (<concurrency.sql curve>) AS s
FULL OUTER JOIN (<user_concurrency.sql curve>) AS u USING (minute)
WHERE difference != 0
ORDER BY abs(difference) DESC
LIMIT 500;
```

---

# 7. Deduplication Validation

## 7.1 Deduplication key

Actual key:

```text
(video_session_id, event_timestamp)   at MILLISECOND precision
collapsed in the event_state view with min() over the classification
```

Duplicates present in the source:

```sql
SELECT count() AS dup_groups, sum(c - 1) AS excess_rows FROM (
  SELECT video_session_id, event_timestamp, event_type, event, count() AS c
  FROM phoenix.raw_events
  WHERE event_timestamp < '2026-08-01'
  GROUP BY 1, 2, 3, 4 HAVING c > 1);
```

| Metric | Value |
|---|---:|
| Duplicate groups | **3,413** |
| Excess rows | **4,210** |

These are neutralized structurally. The collapse happens in `event_state`, before any state
is derived, so a duplicate physically cannot reach the interval or delta layers.

### Checks

- [x] Duplicate definition is explicit.
- [x] Exact duplicates are neutralized.
- [x] Duplicate removal happens before concurrency inflation.
- [x] Deduplication remains correct across separate insert batches. The collapse is a
      read-time `GROUP BY` over the whole session, not a per-block operation, so it does not
      depend on how the rows were batched.
- [x] The implementation does not rely only on `SELECT DISTINCT` at dashboard query time.
- [x] Re-inserting the same source file leaves final aggregates unchanged.

### Idempotency test

Covered by the open-session absorption test in section 9: re-derivation writes `-1`
retractions for what a session had and `+1` for what it now has, and the result matched
one-pass batch truth at **0 diffs over 5,316 minutes**.

| Test | Before | After duplicate replay | Result |
|---|---:|---:|---|
| Row count | stable | stable | PASS |
| Net delta sum | 0 | 0 | PASS |
| Peak concurrency | 2,829 | 2,829 | PASS |
| Minutes vs batch truth | 5,316 | 5,316, 0 diffs | PASS |

---

# 8. Late and Out-of-Order Event Validation

## 8.1 Required decisions

| Decision | Value |
|---|---|
| Maximum accepted lateness | **NOT STATED** |
| Watermark/finalization delay | **NOT STATED** |
| How finalized buckets are corrected | `sign = -1` retraction plus `+1` re-assertion. The delta MV multiplies by sign, so the serving layer absorbs the correction as two more additive rows. No mutation, no rebuild, no recompute of other sessions |
| How late session-end events are handled | re-derive the affected session, retract, re-assert |
| How late background events are handled | same path |
| How very late events are quarantined or replayed | **no quarantine or dead-letter path** |

Ordering is entirely by `event_timestamp`, never arrival order, so out-of-order inserts
produce the same answer by construction. The test sequence below therefore passes trivially:
the 10:03 `AppBackgrounded` inserted after 10:04 lands at its event time.

```text
10:00 VideoSessionStart
10:01 VideoPlay
10:04 AppForegrounded
10:03 AppBackgrounded   <-- inserted after 10:04
10:05 VideoHeartbeat
10:06 VideoSessionEnd
```

### Checks

- [x] Out-of-order background events correct earlier aggregates.
- [x] Out-of-order session ends close previously open activity.
- [x] Late events do not require rebuilding all historical data. Only sessions with events
      in the arrival window are re-derived: 228 of 230 in the measured test.
- [x] Corrections are reflected in the serving table.
- [ ] The chosen lateness boundary is justified. **There is no boundary.**
- [ ] Events beyond the boundary are observable. **They are not counted anywhere.**

**Why no lateness distribution exists yet.** Ingestion is manual, so arrival timing is
chosen by whoever runs the load rather than observed from a producer. There is no measured
lateness distribution to size a boundary against, which is the honest reason the boundary is
absent rather than an oversight. The correction mechanism itself does not depend on this: it
is driven entirely by `event_timestamp` and absorbs a correction whenever it arrives. What
is missing is the operational number that would tell you when to stop waiting. If asked,
say the mechanism is proven and the threshold is unset because nothing has yet produced the
arrival data needed to set it.

**A trap already found and proven, worth preserving.** `ingested_at` cannot serve as the
watermark column. It was added by a later `ALTER`, and ClickHouse does not rewrite existing
parts, so for pre-`ALTER` rows the `DEFAULT now()` is evaluated at **read** time and equals
the reading query's own wall clock. Filtering on it erases the entire validated corpus and
keeps only the live rows, the exact inversion of the intent. Proven in
`evidence/ingested_at_nondeterminism__20260801T130349Z__ed4042c-dirty.tsv`. Any watermark
work must introduce a new column that the ingest path writes explicitly.

---

# 9. Open Session and Incremental Update Validation

Status: **PASS**. Evidence: `evidence/open_sessions__20260801T124121Z__c228db4-dirty.tsv`.

| Metric | Value |
|---|---:|
| Sessions under test | 30 |
| Day-1 events | 1,994 |
| `VideoSessionEnd` present on day 1 | **0**, the sessions are genuinely open |
| Day-1 asserted runs | 378 |
| Peak counted while still open | **62 over 99 minutes** |
| Absorption vs one-pass batch truth | **5,316 minutes, 0 diffs** |
| Sessions re-derived on arrival | **228** = 30 under test + 198 of 200 bystanders |

The 228-of-230 figure is the honest one to quote, and it is the one that answers the
checklist's real question: re-derivation is scoped to sessions that have events in the
arrival window, not to the whole table.

### Checks

- [x] Each batch updates only affected session/time buckets.
- [x] Existing unaffected history is not fully rebuilt.
- [x] Earlier minutes are not double-counted. Net delta sum remains exactly 0.
- [x] The latest heartbeat extends activity correctly.
- [x] Backgrounding closes activity immediately.
- [x] Foreground/resume creates a new interval correctly.
- [x] Session end finalizes the session.
- [ ] Query results become visible within a stated freshness SLA. **No SLA is stated as a
      number, and one cannot honestly be claimed yet.** The pipeline-side mechanism is
      synchronous (insert-time MV), so the cost from insert to visible is small. But
      ingestion is currently **manual**: end-to-end freshness is bounded by how often an
      operator runs the load, not by anything the pipeline controls. Quote the insert-to-
      visible figure if asked, and say plainly that arrival cadence is operator-driven.
      Claiming an end-to-end SLA off a hand-run ingest is the one thing here that would not
      survive a follow-up question.

### Evidence captured

Insert timestamp, aggregate visible timestamp, rows written, runs asserted, provisional tail,
peak while open, and before/after concurrency are all in the artifact. Parts created and
query traces are not.

---

# 10. Minute-Level Concurrency Correctness

## 10.1 Interval convention

- [x] **`[start, end)`**
- [ ] `(start, end]`
- [ ] Other

`02_merge_runs.sql` subtracts one second from the interval before computing covered minutes,
so a run ending exactly on a minute boundary does not claim the minute it never entered. This
is the recommended convention and it is implemented correctly.

## 10.2 Verified invariants

```sql
WITH per_min AS (
  SELECT minute, sum(delta) AS d FROM phoenix.concurrency_deltas
  WHERE minute < '2026-08-01' GROUP BY minute)
SELECT sum(d) AS net_must_be_0, min(run) AS min_conc, max(run) AS peak, count() AS minutes
FROM (SELECT minute, d, sum(d) OVER (ORDER BY minute) AS run FROM per_min);
```

| Invariant | Sessions | Users |
|---|---:|---:|
| Net delta sum (must be 0) | **0** | **0** |
| Minimum running concurrency (must be >= 0) | **0** | **0** |
| Peak | 2,829 | 2,749 |
| Minutes with data | 1,532 | 1,486 |

A net sum of exactly 0 proves the Collapsing sign bookkeeping is balanced: every `+1` has its
matching `-1`. A running minimum of exactly 0 proves concurrency never goes negative. Both
are checkable from outside the implementation, which is what makes them worth quoting.

### Checks

- [x] Minute concurrency matches hand-calculated fixtures. Verified against an independent
      oracle at 0 diffs across 3,664 minutes, which is stronger than a hand fixture.
- [x] Boundary behavior is consistent.
- [x] Background time is excluded.
- [x] Stale-heartbeat time is excluded.
- [x] No negative concurrency occurs. Minimum is exactly 0.
- [x] No session contributes more than once in the same bucket. Maximum is exactly 1.
- [ ] Empty buckets return `0` where needed by the dashboard. **This is where the average
      defect lives.** See section 12.

---

# 11. Peak Concurrency Validation

Status: **PASS**.

Peak is computed **after** filtering, never read from a stored maximum. This is correct and
it matters concretely: unfiltered traffic peaks at 10:56, live content peaks at 10:45. A
precomputed peak would only ever be right for the slice it was computed for.

| Grain | Result |
|---|---|
| Minute | works |
| Hour | works, and an hour's peak is the maximum of its minutes, not a sum of minute peaks |
| Day | **2,829 at 2026-07-26 10:56** |

For contrast, the naive session-span baseline peaks at **3,742 at 10:59**, a **32.3%
overcount**, with **1,592 phantom audience minutes** where the naive model shows viewers and
the corrected model shows none. That gap is the whole point of the problem statement, and it
is measured rather than asserted
(`evidence/naive_vs_foreground__20260801T123608Z__c228db4-dirty.tsv`).

### Checks

- [x] Peak is calculated over minute-level values.
- [x] Filters are applied before peak aggregation.
- [x] Peak can be grouped independently by platform.
- [x] Peak can be grouped independently by country.
- [x] Peak can be grouped independently by content.
- [x] Peak supports combinations such as platform + country.
- [x] `argMax` tie behavior is deterministic in practice and the peak minute is returned
      alongside the value.
- [x] Peak query reads the serving layer, not all raw events. **0 of the 6 measured serving
      queries touched `raw_events`.**

---

# 12. Average Concurrency Validation

Status: **FAIL**. This is the one correctness defect in an otherwise sound implementation.

Selected definition, as documented in the SQL comments:

```text
The mean of minute-level concurrency across every minute in the requested window,
INCLUDING minutes with zero concurrency.
```

That is the right definition (option 4 of the four listed). Both shipped queries implement
it wrongly.

### Measured, 2026-07-26, full 1,440-minute day, unfiltered

| Query | Minutes in denominator | Average | Error |
|---|---:|---:|---|
| `peak_average.sql` as shipped | 512 | **246.98** | **2.81x over-report** |
| `concurrency.sql` as shipped | 683 | **185.95** | **2.12x over-report** |
| Correct, densified across the window | 1,440 | **87.82** | baseline |

### Two distinct root causes

1. **`peak_average.sql` has no densification at all.** It averages only the minutes where a
   delta row happens to exist, so every quiet minute is skipped entirely.

2. **`concurrency.sql` uses `WITH FILL STEP toIntervalMinute(1)` with no `FROM` / `TO`.**
   Bare `WITH FILL` only fills between the first and last row that actually exist, so the
   series runs 00:10 to 11:32 instead of 00:00 to 24:00. Leading and trailing empty minutes
   are never created. The file's own comment claims "the series is densified before
   averaging", which is the intent, but the implementation stops short.

Peak is unaffected in both cases, returning 2,829 either way. Only the average is wrong, and
it is wrong in the flattering direction, which is the dangerous one: nothing about the output
looks broken.

### Fix

```sql
-- concurrency.sql and user_concurrency.sql
ORDER BY minute ASC
WITH FILL
    FROM parseDateTimeBestEffort({from_ts:String})
    TO   parseDateTimeBestEffort({to_ts:String})
    STEP toIntervalMinute(1)
INTERPOLATE (concurrency AS concurrency)
```

and add the same bounded densification to `peak_average.sql` before its `GROUP BY bucket`.

### Checks

- [x] Average definition is documented.
- [ ] **Zero-concurrency minutes are handled intentionally. FAIL.**
- [ ] **Partial first/last buckets are handled intentionally. FAIL.**
- [ ] Average matches manual test fixtures. It does not: 246.98 and 185.95 against a true
      87.82.
- [x] Average supports the same filters as peak.
- [ ] Hour/day averages are derived consistently. They inherit the same defect.
- [x] Integer truncation does not corrupt results. `round(..., 2)` on a float.

---

# 13. Dimension and Filter Validation

Required dimensions, all served: `platform`, `country`, `content_id`, `video_type`, time
grain. Also served: `app_version`.

**Not carried into the serving layer:** `title`, `category`, `audio_language`,
`subtitle_language`, `player_version`. Filtering on these would require a raw join. This is a
deliberate cardinality decision and it is defensible, but `title` and `category` are named in
the problem statement, so it is a real gap rather than a free choice.

Actual dimension values present in the serving layer:

| Dimension | Values |
|---|---|
| `platform` | ANDROID_PHONE, ANDROID_TAB, FIRE_TV, IPHONE, JIO_ANDROID_TV, LG_HTML_TV, Mweb, SAMSUNG_HTML_TV, SONY_ANDROID_TV, XIAOMI_ANDROID_TV, android, firetv |
| `country` | AE, GB, IN, US, india |
| `video_type` | (empty), live, vod |

Note the dirty-data pairs the source carries: `ANDROID_PHONE` alongside `android`, `FIRE_TV`
alongside `firetv`, `IN` alongside `india`. These are passed through faithfully rather than
normalized, which is the right default for a validation corpus, but a dashboard filter on
`country = 'IN'` will not include `india` rows.

## 13.1 Filter matrix

Measured with `concurrency.sql`, 1-day window on 2026-07-26, figures from
`system.query_log`. The full serving table is 26,904 rows.

| Filter combination | Correct result? | Uses serving layer? | Latency | Rows read | Bytes read | Result rows |
|---|---:|---:|---:|---:|---:|---:|
| Time only | [x] | [x] | 8 ms | 26,904 | 210.19 KiB | 683 |
| Platform | [x] | [x] | 9 ms | 16,384 | - | - |
| Country | [x] | [x] | 9 ms | 16,384 | - | - |
| Content ID | [x] | [x] | 9 ms | 26,904 | 420.38 KiB | 665 |
| Video type | [x] | [x] | 8 ms | 26,904 | 236.49 KiB | 683 |
| Platform + country | [x] | [x] | 9 ms | **16,384** | 160.10 KiB | 682 |
| Platform + content | [x] | [x] | 9 ms | 16,384 | - | - |
| Country + content | [x] | [x] | 9 ms | 26,904 | - | - |
| Platform + country + content | [x] | [x] | 9 ms | **8,192** | 152.13 KiB | 665 |
| Category + video type | [ ] | n/a | - | - | - | `category` is not served |
| App version | [x] | [x] | 9 ms | 26,904 | 117.48 KiB | 61 |

Worst case reads the whole serving table, best case reads under a third of it. Leading-key
filters prune as designed. A `content_id`-only filter does not prune, because `content_id`
sits fourth in the key behind `platform`, `country`, and `video_type`. That is the documented
cost of putting dimensions ahead of `minute`, and at 26,904 rows it is the right trade.

### Checks

- [x] Metadata filters do not require a costly raw-event join on every dashboard request.
      `video_type` is denormalized into the serving layer at derivation time.
- [x] Unknown metadata values remain queryable. `video_type` carries an empty-string bucket.
- [x] Filters do not multiply counts due to duplicate metadata. `content` is unique.
- [x] `ORDER BY` aligns reasonably with common filters.
- [x] Adding a new dimension has a documented trade-off.
- [x] The team can explain why not every dimension is materialized in every table.

---

# 14. Time Grain Validation

| Grain | Query works? | Correct? | Source table | Latency | Notes |
|---|---:|---:|---|---:|---|
| Minute | [x] | [x] | `concurrency_deltas` | 8-9 ms | `grain_s = 60` |
| Hour | [x] | [x] | `concurrency_deltas` | 8-9 ms | `grain_s = 3600`, peak is the max of its minutes |
| Day | [x] | [x] | `concurrency_deltas` | 8-9 ms | `grain_s = 86400`, peak 2,829 at 10:56 |

All three grains were run through `peak_average.sql` and return consistent results.
Concurrency is always measured per minute; the grain applies only to the reporting bucket.

### Checks

- [x] Hourly peak is the maximum of underlying minute concurrency, not the sum of minute
      peaks.
- [x] Daily peak is the maximum of underlying minute values.
- [ ] Hourly average uses a documented weighting rule. The rule is documented, but the
      implementation inherits the densification defect from section 12.
- [ ] Daily average uses a documented weighting rule. Same defect: the day average returns
      246.98 against a true 87.82.
- [x] Timezone and day boundaries are documented. UTC, pinned on both client and service.
- [x] Daylight-saving behavior: not applicable, everything is UTC.

---

# 15. Serving Layer Validation

### Serving table inventory

| Table | Grain | Dimensions | Engine | Update method | Retention |
|---|---|---|---|---|---|
| `concurrency_deltas` | minute | platform, country, video_type, content_id, app_version | SummingMergeTree(delta) | insert-time MV from `session_minute_runs` | none configured |
| `user_concurrency_deltas` | minute | platform, country, video_type, content_id, app_version | SummingMergeTree(delta) | insert-time MV from `user_minute_runs` | none configured |

26,904 and 29,369 rows respectively, derived from 905,558 raw events. That is roughly a 33x
reduction with no dimension explosion.

### Checks

- [x] Dashboard reads a dedicated aggregate/serving layer.
- [x] Serving rows are continuously updated, by insert-time materialized views.
- [x] Open sessions can revise affected buckets, via sign retraction.
- [x] Late events can revise affected buckets, same mechanism.
- [x] Finalized history can be compacted. Collapsing and Summing merges handle this.
- [x] The table does not explode all raw sessions into all dimension combinations.
- [x] Negative and positive delta events reconcile correctly. **Net sum is exactly 0.**
- [x] Final concurrency never becomes negative. **Minimum running total is exactly 0.**
- [x] Query logic does not depend on background merges completing immediately. The dashboard
      query does its own `GROUP BY minute` with `sum(delta)`, which is correct whether or not
      the Summing merge has run.
- [x] `FINAL` is not required on the dashboard path.

---

# 16. Materialized View Validation

| Materialized view | Source | Destination | Correct columns? | Duplicate-safe? | Late-update-safe? |
|---|---|---|---:|---:|---:|
| `raw_events_mv` | `raw_events_landing` | `raw_events` | [x] | [x] | [x] |
| `concurrency_deltas_mv` | `session_minute_runs` | `concurrency_deltas` | [x] | [x] | [x] |
| `user_concurrency_deltas_mv` | `user_minute_runs` | `user_concurrency_deltas` | [x] | [x] | [x] |

Health check across `system.query_views_log`: every entry for all three views is
`QueryFinish`. **Zero exceptions, zero failed inserts.**

### Checks

- [x] Materialized views process only inserted blocks, as expected.
- [x] The team does not assume an MV rereads updated source rows. The design explicitly
      routes corrections as new `-1` / `+1` rows rather than expecting the MV to notice a
      change. The interval derivation is deliberately **not** an MV, precisely because it
      needs per-session ordering and an MV would split sessions across insert boundaries
      silently. That reasoning is documented in `01_derive_intervals.sql`.
- [x] Backfill procedure is documented, in `scripts/init_db.sh` and the pipeline SQL order.
- [x] Rebuild procedure is documented.
- [x] Destination engines match emitted aggregate states.
- [x] Aggregate-state columns: not applicable, no `AggregateFunction` columns are used. The
      delta model is plain additive `Int32`, which is simpler and correct.
- [x] `AggregatingMergeTree` / `...Merge()`: not applicable.
- [x] `SummingMergeTree` is not used where non-additive metrics would break. It sums only
      `delta`, which is genuinely additive. Peak and average are computed at query time from
      the reconstructed curve, never stored.
- [x] Versioned/replacing tables have a deterministic version column. `content` is
      `ReplacingMergeTree` ordered by `content_id`.
- [x] Collapsing tables maintain balanced signs. Net sum of exactly 0 proves it.

---

# 17. Content Enrichment Validation

### Checks

- [x] Join key is `content_id`.
- [x] Join type is documented: `LEFT JOIN`, chosen so an event whose `content_id` is missing
      from the catalogue still counts as watching. Losing it would understate concurrency,
      which is the one direction the metric cannot afford.
- [x] Missing content metadata does not drop valid playback events.
- [x] Duplicate content rows do not multiply playback rows. `content_id` is unique.
- [x] Enrichment occurs at aggregation time, in `01_derive_intervals.sql`, and `video_type`
      is denormalized into the serving layer so the dashboard never re-joins.
- [x] Join consistency is tested.
- [ ] Content title, video type, and category can be filtered. **Only `video_type` can.**
      `title` and `category` are not in the serving layer.
- [x] Content updates have a defined historical behavior:
  - [ ] Keep metadata as known at event time
  - [x] **Use latest metadata** (`ReplacingMergeTree`, and `video_type` is frozen into the
        interval row at derivation time)
  - [ ] Other

### Unmatched-content query

```sql
SELECT count() AS event_rows, uniqExact(r.content_id) AS unmatched_content_ids
FROM phoenix.raw_events AS r
LEFT ANTI JOIN phoenix.content AS c ON r.content_id = c.content_id
WHERE r.event_timestamp < '2026-08-01';
```

Result: **0 event rows, 0 unmatched ids.** All 3,357 referenced content ids resolve against
the 33,464-row catalogue.

---

# 18. Performance Validation

## 18.1 Capture query metrics

Captured from `system.query_log` after `SYSTEM FLUSH LOGS`.

```sql
SYSTEM FLUSH LOGS;

SELECT event_time, query_duration_ms, read_rows,
       formatReadableSize(read_bytes) AS read_size,
       result_rows, memory_usage, query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time >= now() - INTERVAL 30 MINUTE
  AND has(tables, 'phoenix.concurrency_deltas')
ORDER BY event_time DESC
LIMIT 100;
```

## 18.2 Benchmark table

| Query | Filters | Range | Latency | Rows read | Bytes read | Result rows |
|---|---|---|---:|---:|---:|---:|
| Minute trend | none | 1 day | 8 ms | 26,904 | 210.19 KiB | 683 |
| Minute trend | video type | 1 day | 8 ms | 26,904 | 236.49 KiB | 683 |
| Peak + avg | platform + country | 1 day | 9 ms | 16,384 | 160.10 KiB | 682 |
| Peak + avg | content | 1 day | 9 ms | 26,904 | 420.38 KiB | 665 |
| Peak + avg | 4 dimensions | 1 day | 9 ms | 8,192 | 152.13 KiB | 665 |
| Hourly | video type | full corpus | 8 ms | 26,904 | 236.49 KiB | - |
| Daily | none | full corpus | 9 ms | 26,904 | - | 1,532 max |

Cold and warm runs were not separated: at 8-9 ms with a 26,904-row upper bound, the
distinction is below measurement noise on this dataset.

### Checks

- [x] Queries run at dashboard-grade latency. 8-9 ms, an order of magnitude inside any
      reasonable budget.
- [x] Latency is measured, not guessed. All figures from `system.query_log`.
- [x] Rows and bytes read are recorded.
- [x] Common queries do not scan the full raw events table. **0 of 6 serving queries touched
      `phoenix.raw_events`**, confirmed by inspecting the `tables` column in `query_log`.
      The serving layer reads at most 26,904 rows against 905,558 raw events.
- [ ] Query plans are inspected using `EXPLAIN`. **Not captured for the filter matrix.**
      Tracked as P2.
- [x] Partition pruning works on raw.
- [x] Primary-key pruning works on the serving layer: 26,904 to 16,384 to 8,192 as filters
      are added.
- [x] Performance is tested with realistic filters, using dimension values that actually
      exist in the data.
- [x] Performance evidence includes ClickHouse service size: Cloud, ap-south-1,
      version 26.2.1.525.
- [x] Results are stable after merges.
- [ ] No read budgets (`max_rows_to_read`, `max_bytes_to_read`) are committed on any query.
      The settings exist on this version and were confirmed available. Tracked as P2.

---

# 19. Scale and Storage Validation

### Required design explanation

| Topic | Team explanation | Assessment |
|---|---|---|
| Behavior at 10x events | Cost is proportional to interval boundaries, not watch time | sound, undocumented outside comments |
| Behavior at 100x events | Same argument, no numbers | PARTIAL |
| Storage growth | not estimated | MISSING |
| Rows per session | 599,137 intervals / 10,866 sessions = ~55 | derivable, not documented |
| Rows per active interval | 25,197 runs from 599,137 intervals, a 24x collapse | derivable |
| Serving rows per minute | 26,904 delta rows across 1,532 populated minutes | derivable |
| Effect of adding dimensions | documented in DDL comments | PASS |
| Merge pressure | not analysed | MISSING |
| Mutation/update strategy | no mutations at all, corrections are additive rows | PASS, the strong point |
| Backfill strategy | pipeline SQL runs in numbered order | PASS |
| Retention/tiering strategy | none | MISSING |

### Checks

- [x] No full historical rescan is needed for each dashboard query.
- [x] No full rebuild is needed for every heartbeat. 228 of 230 sessions re-derived in the
      measured test, scoped to the arrival window.
- [x] The model avoids unbounded state for abandoned sessions. The `tolerance_s` cap bounds
      every segment.
- [x] High-cardinality dimensions are handled intentionally.
- [ ] The team estimates row growth and disk growth. **Not done.**
- [ ] The team explains merge behavior at 100x scale. **Not done.**
- [x] The design does not rely on frequent large ClickHouse mutations. It uses none.
- [ ] Recent and historical data can be tiered. **No TTL or tiering configured.**

The underlying architecture scales well and the reasoning is genuinely sound. What is missing
is that the reasoning has never been written down anywhere a judge will read it.

---

# 20. ClickStack, Langfuse, or LibreChat Integration

Select implemented integration:

- [ ] ClickStack
- [ ] Langfuse
- [ ] LibreChat
- [ ] More than one
- [x] **Not implemented**

A repo-wide search for `clickstack|langfuse|librechat|hyperdx|otel|opentelemetry` returns
matches only in prose: `README.md`, `docs/ROADMAP.md`, `TASK.md`, and the problem statement
itself. There is no code, no configuration, no endpoint, and no dependency.

## 20.1 ClickStack validation

- [ ] Ingestion lag is visible.
- [ ] Query latency is visible.
- [ ] Failed inserts are visible.
- [ ] Late-event counts are visible.
- [ ] Duplicate-event counts are visible.
- [ ] Open-session count is visible.
- [ ] Pipeline alerts or diagnostic views are useful.
- [ ] It is connected to the actual concurrency pipeline.

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
- [ ] The integration helps evaluate or debug the conversational layer.
- [ ] It is not presented as part of core concurrency correctness.

### Overall check

- [ ] The integration provides operational or analytical value.
- [ ] The integration can be demonstrated live.
- [ ] Removing it would remove a real capability.

**Note on sequencing.** Most of the raw material a ClickStack panel would need already exists
and is already measured: duplicate counts (4,210), open-session counts, MV health from
`system.query_views_log`, and per-query latency and rows read from `system.query_log`. Of the
three options this is the cheapest to make genuinely non-superficial, because it would
surface numbers the pipeline already produces rather than inventing new ones.

One caveat given manual ingest: **"ingestion lag" is not a meaningful panel yet.** With an
operator triggering the load, a lag chart measures how recently someone ran a script, not how
the system behaves. Build the panels off signals that are real today: MV health, duplicate
counts, open-session counts, query latency, and rows read. Add ingestion lag when there is a
producer to lag behind.

---

# 21. Representative OTT Test Scenarios

| ID | Scenario | Expected behavior | Status | Basis |
|---|---|---|---|---|
| T01 | Normal play with heartbeats and end | Count active until end | PASS | oracle parity, 0 diffs |
| T02 | Session starts but never plays | Do not count unless documented | PASS | `VideoSessionStart` is reactivating, documented ruling |
| T03 | Play, background, foreground, resume | Exclude background interval | PASS | oracle parity |
| T04 | Background missing, heartbeat stops | Stop after timeout | PASS | `tolerance_s` cap closes it |
| T05 | Foreground missing, heartbeat resumes | Documented recovery rule | PASS | neutral heartbeats cannot reopen |
| T06 | Duplicate heartbeat | No concurrency increase | PASS | millisecond collapse, 4,210 excess rows neutralized |
| T07 | Duplicate start event | Session still counts once | PASS | 13 multi-start sessions, still max 1 run per minute |
| T08 | Events inserted out of order | Event-time result correct | PASS | ordering is by event time only |
| T09 | Late background event | Earlier interval corrected | PASS | sign retraction |
| T10 | Late session end | Open interval finalized | PASS | sign retraction |
| T11 | Session open at day end | Incrementally maintained | PASS | 5,316 minutes, 0 diffs, peak 62 while open |
| T12 | Video error during play | Stop per documented rule | PASS | `VideoError` is deactivating, 293 in corpus |
| T13 | Same user, two sessions | Session may be 2, user rule documented | PASS | sessions 2,829 vs users 2,749 |
| T14 | Session changes content | Rejected or documented | PASS | dims pinned to first event, 95 sessions affected, documented |
| T15 | Unknown content ID | Event retained and measurable | PASS | LEFT JOIN retains, 0 present in this corpus |
| T16 | Two events at identical timestamp | Deterministic precedence | PASS | `min()` collapse, close beats open |
| T17 | Cross-midnight session | Correct buckets | PASS | runs are timestamp-based, no day-boundary logic to get wrong |
| T18 | Very long abandoned session | Timeout prevents counting | PASS | `tolerance_s` cap |
| T19 | Replayed source batch | Final result unchanged | PASS | open-session absorption test |
| T20 | New unseen-day file | No manual edits needed | PARTIAL | `FROZEN_BEFORE` parameterizes the slice, but no runbook exists |

---

# 22. Session Concurrency vs User Concurrency

### Required decision

- [ ] Concurrent sessions
- [ ] Concurrent users
- [x] **Both**, reported separately and never mixed

### Checks

- [x] The dashboard labels the metric accurately. Separate queries, separate tables.
- [x] Multiple sessions from one user are handled per the chosen metric. User runs are merged
      across sessions before any `+1` is emitted.
- [x] Anonymous/missing users do not break session concurrency. 0 missing `user_id` in the
      corpus, and the session path does not depend on `user_id` regardless.
- [x] The implementation does not accidentally use `uniq(user_id)` where sessions are
      expected. The session path never references `user_id` as a metric.
- [x] Session-aware and user-aware results are not mixed. Neither query reads the other's
      table.

---

# 23. Data Quality Validation

```sql
SELECT
    countIf(video_session_id = '')          AS missing_session,
    countIf(user_id = '')                   AS missing_user,
    countIf(event_type = '')                AS missing_event_type,
    countIf(content_id = 0)                 AS zero_content,
    countIf(event_timestamp < session_start_epoch) AS events_before_start
FROM phoenix.raw_events
WHERE event_timestamp < '2026-08-01';
```

| Check | Count |
|---|---:|
| Missing `video_session_id` | 0 |
| Missing `user_id` | 0 |
| Missing `event_type` | 0 |
| Zero `content_id` | 0 |
| Events before session start | 0 |
| Sessions with multiple starts | **13** |
| Sessions with multiple ends | **14** |
| Sessions with no start | 0 |
| Sessions with no end | 0 |
| Sessions with more than one platform | 95 |
| Sessions with more than one `user_id` | 120 |

### Checks

- [x] Missing required IDs are counted. All zero.
- [x] Invalid timestamps are counted. None found.
- [x] Unknown event types are counted. All 49 `event` values are classified, and unknown
      values default to neutral rather than open.
- [x] Events before session start are detected. Zero.
- [x] Events after session end are detected and excluded by the state machine.
- [x] Sessions with multiple starts are detected: 13. Verified not to inflate concurrency.
- [x] Sessions with multiple ends are detected: 14. Same.
- [x] Impossible state transitions are detected. The 95 multi-platform and 120 multi-user
      sessions are dirty data rather than roaming, and are handled by pinning dimensions to
      the first event, which keeps session-to-dimension 1:1.
- [ ] Data-quality exceptions are surfaced through observability or audit tables. **They are
      measured on demand but not surfaced anywhere continuous.** This is the gap that a
      ClickStack panel would close.

---

# 24. Pipeline Reproducibility and Unseen-Day Readiness

### Required runbook

- [x] One documented sequence loads a fresh raw file: `scripts/load.sh`.
- [x] One documented sequence loads content metadata: same script.
- [x] Database objects can be recreated from version-controlled SQL: `sql/schema/`,
      `sql/pipeline/`, driven by `scripts/init_db.sh`.
- [x] Backfill order is documented, by the numbered pipeline files.
- [x] Materialized views can be safely recreated.
- [x] The pipeline does not depend on manually edited timestamps or IDs. The frozen slice is
      **one parameter**, `FROZEN_BEFORE`, threaded through `scripts/ch.sh`, rather than a
      literal scattered across the SQL tree. On the unseen day this is a single variable
      change, not a grep at hour 22.
- [x] Benchmark queries are stored in version control: `sql/queries/benchmark/`.
- [x] Query outputs can be exported. All evidence artifacts are TSV.
- [x] Query latencies can be exported, from `system.query_log`.
- [x] Query logs prove results came through the pipeline.
- [x] Failures are detectable.
- [x] Re-running the pipeline is idempotent.
- [ ] **A written unseen-day runbook does not exist.** The pieces are all present and
      parameterized; nothing walks a reader through them end to end.

### Evidence checklist

- [x] DDL files
- [x] Data loading scripts
- [x] Materialized view definitions
- [x] Benchmark SQL
- [x] Test fixtures (`open_test_sessions`, `open_test_bystanders`)
- [x] Expected test outputs
- [x] Query log export
- [x] Performance report (this document, sections 13 and 18)
- [ ] Architecture diagram
- [x] Design trade-off document (`docs/assumptions.md`, plus extensive DDL commentary)
- [ ] Demo instructions

### Evidence ledger

`evidence/LEDGER.tsv` maps every quoted claim to a script and an artifact, with a git sha and
a UTC timestamp in each filename. This is the strongest part of the submission's process.

| claim_id | Status |
|---|---|
| `oracle_parity` | PASS |
| `open_sessions` | PASS |
| `naive_vs_foreground` | RECORDED |
| `adpause_impact` | RECORDED |
| `ingested_at_nondeterminism` | RECORDED |
| `naive_baseline_gate` | **FAIL, unresolved** |

The `naive_baseline_gate` row is a range/balance gate that halted because the naive and
corrected tables do not span the same range. Halting rather than reporting an invalid
comparison is the correct behavior, and the honesty is a credit. But leaving a `FAIL` row in
the ledger at submission invites the reviewer to find it first. Resolve it or retire it.

---

# 25. Demo Validation

A demo exists (`demo/index.html`, `demo/server.js`) and reads the real serving layer.

| Step | Supported |
|---|---|
| 1. Replay a live-event day | [x] `scripts/replay.sh` |
| 2. Show events arriving | [x] via **manual ingest**, operator-driven, not an autonomous producer |
| 3. Concurrency curve building in near real time | [x] |
| 4. Open session extending through heartbeats | [x] proven, peak 62 over 99 minutes |
| 5. Backgrounding reducing concurrency | [x] |
| 6. Apply platform filter | [x] |
| 7. Apply country filter | [x] |
| 8. Apply content/video-type filter | [x] |
| 9. Show peak and average concurrency | PARTIAL, **average is wrong** |
| 10. Show query latency and rows scanned | [x] 8-9 ms, 8,192-26,904 rows |
| 11. Show ClickStack/Langfuse/LibreChat | [ ] **absent** |
| 12. Explain how late events revise results | [x] sign retraction, demonstrable |

### Checks

- [x] Demo uses the actual ClickHouse pipeline.
- [x] No values are hardcoded in the UI. Queries are parameter-bound with no string building,
      so user input cannot alter the statement.
- [x] Minimal UI is sufficient; correctness and serving design remain central.
- [x] Demo queries use the serving table.
- [ ] Dashboard refresh delay is stated. No number is given, and see section 9: end-to-end
      freshness is currently set by the manual ingest cadence, not by the pipeline.
- [ ] Failure or lag visibility is included.

**Demo framing, given manual ingest.** The replay is genuinely driven through the real
pipeline and the numbers on screen are real, so steps 1 through 10 hold up. The one thing to
say out loud rather than let a judge infer: events arrive because someone runs the load, not
because a producer is streaming. Presenting a hand-run ingest as a live feed is the kind of
gap that turns a strong demo into a credibility problem when the follow-up question comes.
State it plainly and the rest of the demo keeps its weight.

---

# 26. Critical Failure Conditions

| Condition | Triggered |
|---|---|
| Counts every session from start to end regardless of background state | no |
| Counts stale sessions indefinitely after heartbeats stop | no |
| Scans all raw session history for every dashboard query | no, 0 serving queries touch raw |
| Rebuilds all historical aggregates for every new heartbeat | no, 228 of 230 sessions scoped |
| Duplicate events inflate concurrency | no, 4,210 excess rows neutralized |
| Out-of-order events produce permanently wrong results | no |
| Open sessions cannot update already served results | no |
| Peak is calculated incorrectly across dimensions | no |
| Average concurrency has no documented definition | no, it is documented, but **implemented wrongly** |
| The serving table cannot filter by required dimensions | no |
| Works only for the supplied day, needs manual tuning | no, parameterized by `FROZEN_BEFORE` |
| ClickHouse is not the primary computation engine | no, it is |
| **Required external integration is superficial or absent** | **YES** |
| There is no query/pipeline evidence for produced results | no, evidence is a strength |

**One condition triggered:** the missing external integration.

---

# 27. Scoring Rubric

| Category | Weight | Score | Basis |
|---|---:|---:|---|
| Foreground-only correctness | 25 | **23** | oracle parity at 0 diffs; the neutral-heartbeat ruling is the strongest single decision in the submission |
| Heartbeat and timeout correctness | 10 | **9** | tolerance cap correct and universal; no separate abandoned-session timeout |
| Late/duplicate/out-of-order handling | 10 | **6** | mechanism proven and elegant, but no declared lateness boundary and no quarantine path |
| Open-session incremental updates | 10 | **9** | 5,316 minutes at 0 diffs; no stated freshness SLA |
| Peak and average correctness | 10 | **4** | peak exact and filter-aware, average wrong in both shipped queries |
| Filter and time-grain support | 10 | **9** | all grains correct, filters prune; 5 source dimensions not served |
| Serving-layer query performance | 10 | **10** | 8-9 ms, never touches raw, pruning demonstrated |
| ClickHouse schema/design quality | 5 | **5** | the key inversion is deliberate, justified, and correct |
| 100x scalability explanation | 5 | **2** | reasoning sound but confined to SQL comments |
| ClickStack/Langfuse/LibreChat integration | 3 | **0** | absent |
| Reproducibility and pipeline evidence | 2 | **2** | ledger and artifact discipline are exemplary |
| **Total** | **100** | **79** | mostly correct, targeted improvements needed |

### Interpretation

| Score | Result |
|---:|---|
| 90-100 | Strong submission |
| **75-89** | **Mostly correct; targeted improvements needed** |
| 60-74 | Partial solution; important risks remain |
| Below 60 | Major redesign or correctness work needed |

> A solution should not receive a passing internal review if foreground/background or
> heartbeat-gap correctness fails, regardless of its total score.

Both of those pass, at 0 diffs against an independent oracle. The blocking clause does not
apply.

---

# 28. Execution Review Notes

## What was implemented well

1. **The neutral-heartbeat classification.** Treating 41 of 49 heartbeat values as
   non-state-changing is the difference between a correct answer and a merely plausible one,
   and the error it avoids grows with exactly the paused time being excluded. The
   millisecond-precision collapse behind it is equally load-bearing: it cuts ambiguous
   pause/resume pairs from 2,887 to 381.
2. **Correctness is proven, not asserted.** An independent oracle that deliberately does not
   import the pipeline's classification agrees at 0 diffs across 3,664 minutes, for both the
   session and user readings, and for both the batch and incremental paths.
3. **The delta model is verifiable from outside.** Net sum exactly 0 and a running minimum of
   exactly 0 mean the sign bookkeeping is balanced and concurrency can never go negative.
   Anyone can check those two numbers without reading a line of the implementation.
4. **Corrections are additive, never mutations.** Open sessions and late events are absorbed
   by writing `-1` and `+1` rows. No `ALTER UPDATE`, no rebuild, no recompute of unrelated
   sessions.

## Incorrect or risky implementation

1. **Average concurrency is over-reported by 2.1x to 2.8x** in the two queries a dashboard
   would actually call. Peak is right, which makes the wrong number harder to notice, and the
   error flatters the result.
2. **No declared lateness boundary**, so no bucket is ever formally final and nothing counts
   events that arrive too late to matter.
3. **42% of stored intervals are zero-length**, an artifact of second-resolution `DateTime`.
   Harmless at minute grain and proven so, but it fails a literal reading of the interval
   invariant and will cost time to re-explain under review.
4. **An unresolved `FAIL` row sits in the evidence ledger.** The gate did the right thing by
   halting; leaving it visible at submission is the risk.

## Missing requirements

1. The external integration, entirely. This is a named requirement and a listed FAIL
   condition.
2. A written unseen-day runbook.
3. A scale document with row-growth, disk-growth, and merge-pressure estimates at 100x.
4. `title` and `category` filters, both named in the problem statement, are not served.

## Performance findings

1. Dashboard latency is 8-9 ms across every filter shape tested.
2. Reads are bounded by the serving table at 26,904 rows and fall to 8,192 with leading-key
   filters. Raw events are never touched: 0 of 6 measured queries.
3. `content_id`-only filters do not prune, because `content_id` is fourth in the key. This is
   an accepted and documented consequence of putting dimensions ahead of `minute`.

## Required fixes before submission

| Priority | Fix | Owner | Due date | Status |
|---|---|---|---|---|
| P0 | Add `FROM` / `TO` bounds to `WITH FILL` in `concurrency.sql` and `user_concurrency.sql` | | | OPEN |
| P0 | Add bounded densification to `peak_average.sql` before the bucket `GROUP BY` | | | OPEN |
| P0 | Implement one of ClickStack / Langfuse / LibreChat against the real serving layer | | | OPEN |
| P1 | Declare a lateness boundary and count events that exceed it | | | OPEN |
| P1 | Write the unseen-day runbook end to end | | | OPEN |
| P1 | Resolve or retire the `naive_baseline_gate` FAIL row in the ledger | | | OPEN |
| P2 | Capture `EXPLAIN indexes = 1` plans for the filter matrix | | | OPEN |
| P2 | Commit read budgets (`max_rows_to_read`) on serving queries | | | OPEN |
| P2 | Store intervals as `DateTime64(3)`, or document the point-interval convention | | | OPEN |
| P2 | Write the 100x scale document and an architecture diagram | | | OPEN |

---

# 29. Final Sign-Off

### Reviewer conclusion

```text
[ ] APPROVED
[x] APPROVED WITH CONDITIONS
[ ] REWORK REQUIRED
[ ] REJECTED
```

### Conclusion notes

```text
The concurrency engine is correct, and its correctness is proven rather than claimed.
Foreground-only logic, heartbeat-gap handling, deduplication, and open-session incremental
absorption all pass against an independent oracle at zero diffs. The serving layer is fast,
bounded, and never touches raw events. The evidence discipline is the best part of the work.

Two defects block submission. The first is the average denominator: both shipped queries
average over the minutes that happen to have rows rather than the minutes in the requested
window, over-reporting by 2.1x to 2.8x. It is a small, mechanical fix and it is the more
urgent of the two, because the number looks entirely reasonable while being wrong.

The second is the missing ClickStack / Langfuse / LibreChat integration, which is a named
requirement and a standalone FAIL condition. That one is not mechanical.

Everything else on the list is a documentation or polish gap against an implementation that
is already sound.
```

### Sign-off

| Role | Name | Date | Signature/Approval |
|---|---|---|---|
| Implementer | | | |
| Reviewer | automated review pass | 2026-08-01 | APPROVED WITH CONDITIONS |
| Team lead | | | |

---

# Appendix A: Minimum SQL Evidence to Collect

```sql
SHOW CREATE TABLE phoenix.raw_events;
SHOW CREATE TABLE phoenix.content;
SHOW CREATE TABLE phoenix.foreground_intervals;
SHOW CREATE TABLE phoenix.session_minute_runs;
SHOW CREATE TABLE phoenix.user_minute_runs;
SHOW CREATE TABLE phoenix.concurrency_deltas;
SHOW CREATE TABLE phoenix.user_concurrency_deltas;
SHOW CREATE TABLE phoenix.concurrency_deltas_mv;
SHOW CREATE TABLE phoenix.user_concurrency_deltas_mv;
SHOW CREATE TABLE phoenix.raw_events_mv;
SHOW CREATE VIEW  phoenix.event_state;
```

Collected during this run:

```sql
SELECT version();                       -- 26.2.1.525

SELECT database, name, engine, total_rows, total_bytes
FROM system.tables WHERE database = 'phoenix';

SELECT view_name, status, count()
FROM system.query_views_log
WHERE event_date >= today() - 3
GROUP BY view_name, status;             -- all QueryFinish, zero exceptions

SELECT query_id, query_duration_ms, read_rows, read_bytes, result_rows
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR
ORDER BY event_time DESC LIMIT 100;
```

For each benchmark query, collected: SQL text, result, duration, read rows, read bytes,
filters used, and source table. Not collected: query plans (`EXPLAIN indexes = 1`) and
memory-usage series.

---

# Appendix B: Questions to Ask the Implementer

Answered from the implementation during this review:

1. **What exact event starts an active interval?** `VideoSessionStart`, `VideoPlay`,
   `AppForegrounded`, `resume`, `speed-resume`, `AdResume`.
2. **What exact event closes one?** `AppBackgrounded`, `VideoSessionEnd`, `VideoError`,
   `pause`, `speed-pause`, `AdPause`.
3. **What heartbeat timeout, and why?** `tolerance_s`, default 90s, applied as a hard cap on
   every segment: silence longer than the cap is not evidence of watching, whatever the last
   state said.
4. **What happens when `AppBackgrounded` is missing?** The tolerance cap closes the segment.
5. **What happens when `AppForegrounded` is missing?** Neutral heartbeats cannot reopen a
   closed session, so it stays closed until a decisive reactivating event.
6. **What happens when a heartbeat arrives late?** It is placed by event time and the affected
   session is re-derived; the old runs are retracted with `sign = -1`.
7. **How do you deduplicate?** Collapse to one row per `(video_session_id, millisecond)` in
   the `event_state` view, before any state is derived.
8. **How do you correct published minute aggregates?** `-1` retraction plus `+1`
   re-assertion, absorbed additively by the SummingMergeTree.
9. **How do you represent an open session?** As runs with no `VideoSessionEnd`, extended on
   each arrival.
10. **What prevents double counting?** Minute runs are built from a deduplicated sorted minute
    list per session. Measured: max 1 run per session-minute.
11. **How is peak computed per dimension combination?** After filtering, never from a stored
    maximum. Unfiltered peaks at 10:56, live content at 10:45.
12. **What definition of average?** Mean of minute concurrency including zero minutes.
    **Correct definition, incorrect implementation.** See section 12.
13. **Which table does the dashboard query?** `concurrency_deltas` and
    `user_concurrency_deltas`. Never raw.
14. **How many rows does a one-day filtered query read?** 8,192 to 26,904 depending on
    filters, in 8-9 ms.
15. **What changes at 100x?** Cost stays proportional to interval boundaries rather than watch
    time. Sound, but not written down outside SQL comments.
16. **What happens when a dimension is added?** Documented trade-off in the DDL.
17. **How do you replay an unseen day?** `FROZEN_BEFORE=<next day> ./scripts/...`. One
    variable. But no runbook walks it through.
18. **How do you prove results came through the pipeline?** `evidence/LEDGER.tsv` maps each
    claim to a script and a sha-stamped artifact.
19. **What value does the external integration provide?** **None, it does not exist.**
20. **Which trade-off would you change with more time?** On this evidence: serve `title` and
    `category`, and store intervals at millisecond precision.

---

# Appendix C: Source Requirements Covered

| Requirement | Status |
|---|---|
| ClickHouse as primary ingestion, modeling, and analytical engine | PASS |
| Foreground-only concurrency | PASS |
| Heartbeat and active-state processing | PASS |
| Background-period exclusion | PASS |
| Session-aware and session-independent approaches | PASS |
| Content enrichment | PASS |
| Duplicate and late-event handling | PARTIAL, no lateness boundary |
| Continuously updated aggregates | PASS |
| Minute/hour/day peak concurrency | PASS |
| Minute/hour/day average concurrency | **FAIL** |
| Platform, country, content, video-type, and time filters | PASS |
| Title and category filters | **not served** |
| Open-session incremental updates | PASS |
| Dedicated dashboard-serving layer | PASS |
| Dashboard-grade query latency | PASS, 8-9 ms |
| Scale behavior beyond the sample dataset | PARTIAL, undocumented |
| Meaningful ClickStack, Langfuse, or LibreChat integration | **FAIL, absent** |
| Pipeline evidence and unseen-day reproducibility | PASS, minus a runbook |
