# SonyLIV Click-a-thon 2026 — Implementation Validation, filled in

Validated against `sonyliv_clickhouse_implementation_validation_checklist.md`.
Every value below came from a live query against the service this run; nothing is asserted
from documentation.

- Validated by: automated review pass
- Validation date: 2026-08-01
- Service: ClickHouse Cloud `26.2.1.525`, database `phoenix`, ap-south-1
- Scope predicate: `event_timestamp < '2026-08-01'` (the frozen validated corpus).
  Live-stream rows from 2026-08-01 share `raw_events` and are excluded from every
  correctness number.

---

## 1. Validation summary

| Area | Status | Evidence |
|---|---|---|
| Raw event ingestion | PASS | 905,558 rows loaded = 905,559 CSV lines minus header, exact |
| Content metadata ingestion | PASS | 33,464 rows = 33,465 lines minus header; 0 duplicate `content_id` |
| Schema matches source datasets | PASS | all 13 source columns present and typed; epoch millis to `DateTime64(3)` |
| Event-to-content enrichment | PASS | LEFT JOIN on `content_id`; 0 unmatched event rows |
| Duplicate event handling | PASS | 4,210 excess duplicate rows in source, collapsed by `(session, ms)` before state |
| Late-arriving event handling | PARTIAL | event-time throughout, additive corrections work; no stated lateness boundary |
| Foreground/background state logic | PASS | oracle parity 3,664 minutes, 0 diffs |
| Heartbeat-gap handling | PASS | `tolerance_s` caps every segment at `ts + tol` |
| Session-aware aggregation | PASS | max 1 run per session-minute, verified |
| Session-independent aggregation | PASS | separate user rollup, 3,664 minutes, 0 diffs vs oracle |
| Open-session incremental updates | PASS | 5,316 minutes, 0 diffs vs one-pass batch truth |
| Minute concurrency serving table | PASS | `concurrency_deltas`, 26,904 rows |
| Peak concurrency queries | PASS | filter-aware, computed after filtering; peak 2,829 at 10:56 |
| Average concurrency queries | **FAIL** | both shipped queries over-report; 2.81x and 2.12x measured |
| Dimension filters | PASS | all required dimensions filterable, filters prune reads |
| Hour/day aggregation | PASS | grain 60 / 3600 / 86400 all correct; hour peak = max of its minutes |
| Query latency | PASS | 8-9 ms across every filter shape |
| Rows/bytes scanned | PASS | 8,192-26,904 rows; 0 serving queries touch `raw_events` |
| 100x scalability explanation | PARTIAL | reasoning lives in SQL comments, no written design doc |
| ClickStack/Langfuse/LibreChat | **FAIL** | not implemented; no code, config, or endpoint anywhere in the repo |
| Pipeline evidence and reproducibility | PASS | `evidence/LEDGER.tsv`, 6 artifacts, all scripts version-controlled |

### Final result

- **Overall status: `APPROVED WITH CONDITIONS`** — core concurrency correctness is proven,
  two shipped defects must be fixed before submission.
- **Critical failures**
  1. Average concurrency is computed over the wrong denominator in both serving queries.
  2. The required external integration (ClickStack / Langfuse / LibreChat) is absent. The
     checklist lists this as a standalone FAIL condition.
- **Major risks**
  1. No documented maximum lateness or watermark, so there is no stated point at which a
     bucket is final.
  2. `evidence/LEDGER.tsv` carries a `FAIL` row (`naive_baseline_gate`) that is unresolved.
- **Recommended fixes:** see the P0 table at the end.

---

## 2. Source data

### 2.1 Raw events

All 13 logical columns present, correctly typed, nothing silently dropped.

| Column | Type as loaded | Present | Correct |
|---|---|---|---|
| `video_session_id` | `String` | yes | yes, not coerced to a numeric |
| `user_id` | `String` | yes | yes |
| `content_id` | `Int64` | yes | yes, matches `content.content_id` |
| `event_type` | `LowCardinality(String)` | yes | yes |
| `event` | `LowCardinality(String)` | yes | yes |
| `event_timestamp` | `DateTime64(3)` | yes | yes, millisecond precision retained |
| `platform` | `LowCardinality(String)` | yes | yes |
| `app_version` | `LowCardinality(String)` | yes | yes |
| `country` | `LowCardinality(String)` | yes | yes |
| `audio_language` | `LowCardinality(String)` | yes | yes |
| `subtitle_language` | `LowCardinality(String)` | yes | yes |
| `player_version` | `LowCardinality(String)` | yes | yes |
| `session_start_epoch` | `DateTime64(3)` | yes | yes |

Loaded volume, frozen slice:

| Metric | Value |
|---|---|
| Rows | 905,558 |
| Sessions | 10,866 |
| Users | 9,618 |
| Contents | 3,357 |
| First event | 2026-07-14 15:43:58.144 |
| Last event | 2026-07-26 11:30:04.847 |

Source-to-loaded comparison: `wc -l` on the CSV gives 905,559 lines. Minus the header that
is 905,558, matching the loaded count exactly. Nothing was dropped or duplicated on load.

Event type mix:

| `event_type` | Rows | Distinct `event` values |
|---|---:|---:|
| VideoHeartbeat | 843,600 | 41 |
| AppBackgrounded | 14,700 | 1 |
| AppForegrounded | 14,321 | 1 |
| VideoPlay | 10,883 | 1 |
| VideoSessionEnd | 10,881 | 1 |
| VideoSessionStart | 10,880 | 1 |
| VideoError | 293 | 1 |

All 7 expected `event_type` values are present.

- [x] Expected raw volume loaded
- [x] No source columns silently dropped
- [x] `event_timestamp` stored as `DateTime64(3)`
- [x] Timezone documented and pinned: `--session_timezone UTC` in `scripts/ch.sh`
- [x] `content_id` type matches the content table (`Int64` both sides)
- [x] Session and user IDs kept as `String`, not lossily numeric
- [x] Raw data retained for replay
- [x] Source and loaded row counts compared

### 2.2 Content metadata

| Metric | Value |
|---|---|
| Rows | 33,464 |
| Unique `content_id` | 33,464 |
| Duplicate ids | 0 |

- [x] Expected content volume loaded
- [x] `content_id` unique, so no fan-out risk
- [x] Available at aggregation time (joined during interval derivation)
- [x] Unmatched ids measurable: the count is 0
- [x] Metadata cannot multiply event rows, uniqueness proven

---

## 3. Table architecture

| Object | Engine | Rows | Purpose |
|---|---|---:|---|
| `raw_events` | SharedMergeTree | 960,851 | append-only source of truth |
| `raw_events_landing` | Null | 0 | CSV-shaped landing, pass-through only |
| `raw_events_mv` | MV | - | epoch millis to `DateTime64` |
| `content` | SharedReplacingMergeTree | 33,464 | metadata |
| `event_state` | View | - | the state machine, single definition |
| `foreground_intervals` | SharedMergeTree | 631,103 | active intervals per session |
| `session_minute_runs` | SharedCollapsingMergeTree | 25,197 | minute runs, retractable |
| `concurrency_deltas` | SharedSummingMergeTree | 26,904 | session serving layer |
| `concurrency_deltas_mv` | MV | - | run to +1/-1 pair |
| `user_minute_runs` | SharedCollapsingMergeTree | 18,145 | user runs merged across sessions |
| `user_concurrency_deltas` | SharedSummingMergeTree | 29,369 | user serving layer |
| `user_concurrency_deltas_mv` | MV | - | run to +1/-1 pair |

- [x] Raw ingestion table exists
- [x] Content metadata table exists
- [x] Enrichment strategy implemented (JOIN at derivation, dictionary deliberately rejected)
- [x] Session-aware interval layer exists
- [x] Session-independent layer exists and is a genuinely separate rollup
- [x] Dashboard-facing serving table exists
- [x] Every MV has a valid source and destination; 0 exceptions in `system.query_views_log`
- [x] Engines justified: Collapsing for retractable runs, Summing for additive deltas
- [x] `ORDER BY` supports real filters, with a deliberate inversion documented below
- [x] Partitioning by `toYYYYMMDD(event_timestamp)` on raw
- [x] High-cardinality dimensions not blindly keyed everywhere
- [x] Defaults intentional
- [ ] Retention/TTL: not configured, not documented

The `concurrency_deltas` key puts dimensions first and `minute` last. This inverts the usual
reflex on purpose: a cumulative sum has to start at the first minute of the series, so a
time predicate must not prune. Only a dimension filter can. The measured read costs below
confirm the design does what it claims.

---

## 4. Foreground-only business logic

| Decision | Implementation | Status |
|---|---|---|
| Which events start active playback | `VideoSessionStart`, `VideoPlay`, `AppForegrounded`, and `resume`/`speed-resume`/`AdResume` | PASS |
| Which events stop it | `AppBackgrounded`, `VideoSessionEnd`, `VideoError`, and `pause`/`speed-pause`/`AdPause` | PASS |
| Does `VideoSessionStart` count immediately | yes, treated as reactivating | PASS |
| Does `VideoPlay` start/resume | yes | PASS |
| Does `AppBackgrounded` stop immediately | yes | PASS |
| Does `AppForegrounded` resume immediately | yes, immediately | PASS |
| Does `VideoSessionEnd` close | yes | PASS |
| Does `VideoError` close | yes | PASS |
| Heartbeat gap marking inactive | every segment capped at `ts + tolerance_s`, default 90s | PASS |
| Session timeout | same `tolerance_s` cap; no separate timeout | PASS |
| Missing background/foreground events | last decisive state carried forward, capped by tolerance | PASS |
| Out-of-order events | irrelevant, all ordering is by `event_timestamp` | PASS |
| Identical duplicate events | collapsed to one row per `(session, millisecond)` | PASS |
| Contradictory events | `min()` at the same millisecond, so a close beats an open | PASS |

The decisive design point: 41 of the 49 `event` values under `VideoHeartbeat` are **neutral**
and must not flip state. Treating them as reactivating means a `pause` is cancelled by the
very next buffer-health row, so paused time is counted as watching, and the error grows with
the thing being excluded. An unrecognised value is neutral, never open, so a new event type
cannot manufacture viewing time.

- [x] Backgrounded intervals excluded
- [x] Time after a stale heartbeat excluded
- [x] Time after session end excluded
- [x] Time after an unrecovered error excluded
- [x] Foregrounding does not count still-paused playback
- [x] A session contributes at most 1 at an instant — **verified: max runs covering one
      session-minute = 1**
- [x] Repeated heartbeats cannot multiply concurrency
- [x] The rule is written clearly enough to reproduce; the oracle is an independent
      reimplementation and agrees at 0 diffs

---

## 5. Session-aware model

Representation: **one normalized row per active interval**, merged into minute runs, then
into a delta model.

| Check | Result |
|---|---|
| `interval_end < interval_start` | **0** |
| `interval_end = interval_start` | 253,590 of 599,137 |
| `interval_end > interval_start` | 345,547 |
| Overlapping runs per session after merge | **0** |
| Max runs covering one session-minute | **1** |

On the zero-length intervals: `foreground_intervals` stores `DateTime` (second resolution),
so a segment shorter than a second truncates to a point. `timeSlots(start, 0, 60)` still
yields exactly one minute, so the minute is covered correctly and the run merge dedupes it.
The checklist's literal `active_start < active_end` requirement therefore reads as violated,
but the minute-grain output is provably right: zero overlapping runs, and never more than one
run per session-minute. Recommend storing `DateTime64` or documenting the point-interval
convention so a reviewer is not left to derive this.

- [x] Every interval belongs to one session
- [x] Intervals cannot extend past a known end
- [x] Background events close intervals
- [x] Heartbeat timeout closes stale intervals
- [x] Open sessions distinguishable (no `VideoSessionEnd` present)
- [x] Late events can correct emitted intervals, via `sign = -1` retraction
- [x] Corrections leave no duplicate runs (0 overlaps measured)
- [x] Reprocessing is idempotent, proven by the open-session test

---

## 6. Session-independent model

A genuinely separate rollup, not an alias. A user's runs are merged **across all their
sessions** before any `+1` is emitted, so one person on a phone and a TV counts once.

| Metric | Sessions | Users |
|---|---:|---:|
| Peak | 2,829 | 2,749 |
| Minutes with data | 1,532 | 1,486 |
| Net delta sum (must be 0) | **0** | **0** |
| Minimum running concurrency (must be >= 0) | **0** | **0** |
| Oracle parity | 3,664 minutes, 0 diffs | 3,664 minutes, 0 diffs |

- [x] Separate aggregate exists
- [x] Not an alias
- [x] Transition logic documented
- [x] Handles background/foreground and heartbeat gaps identically
- [x] Comparable at the same grain and dimensions
- [x] Divergence measurable: peak 2,829 vs 2,749, an 80-viewer gap
- [x] The team can explain it: multi-device users

Known trade-off, documented in the DDL: a user is attributed to the dimensions of their
**first** run. 7 users of 9,510 watch on more than one platform, so a platform filter files
them under the platform they started on. This keeps the unfiltered total exact, which is the
right call, but a platform-filtered user number is approximate for those 7.

---

## 7. Deduplication

Actual key: **`(video_session_id, event_timestamp)` at millisecond precision**, collapsed
in the `event_state` view with `min()` over the classification.

Source contains **3,413 duplicate groups, 4,210 excess rows**. They are neutralized
structurally: the collapse happens before any state is derived, so a duplicate cannot reach
the delta model at all. This is not a `SELECT DISTINCT` at dashboard time.

- [x] Duplicate definition explicit
- [x] Exact duplicates neutralized
- [x] Removal happens before concurrency inflation
- [x] Correct across insert batches (the collapse is a read-time GROUP BY, not per-block)
- [x] Not reliant on query-time `DISTINCT`
- [x] Replay leaves aggregates unchanged, proven by the open-session absorption test

---

## 8. Late and out-of-order events

| Decision | Value |
|---|---|
| Maximum accepted lateness | **not stated** |
| Watermark / finalization delay | **not stated** |
| How finalized buckets are corrected | `sign = -1` retraction plus `+1` re-assertion; the MV multiplies by sign so the serving layer absorbs it additively |
| How late session-ends are handled | re-derive the affected session, retract, re-assert |
| How late background events are handled | same path |
| Very late events | no quarantine or dead-letter path |

Ordering is entirely by `event_timestamp`, never arrival order, so out-of-order inserts
produce the same answer. The correction mechanism is real and tested. What is missing is a
**stated boundary**: nothing declares when a bucket is final, and nothing counts events that
arrive beyond it.

- [x] Out-of-order background events correct earlier aggregates
- [x] Out-of-order ends close previously open activity
- [x] No full historical rebuild required
- [x] Corrections reach the serving table
- [ ] Lateness boundary justified — **absent**
- [ ] Events beyond the boundary observable — **absent**

Note: `ingested_at` cannot be used as the watermark. It was added by a later `ALTER`, and
ClickHouse does not rewrite existing parts, so for pre-`ALTER` rows the `DEFAULT now()` is
evaluated at **read** time and equals the reading query's wall clock. Filtering on it erases
the validated corpus entirely. This is proven in
`evidence/ingested_at_nondeterminism__20260801T130349Z__ed4042c-dirty.tsv`. Any watermark
work must introduce a new, explicitly-written column.

---

## 9. Open sessions and incremental updates

Status: **PASS**, from `evidence/open_sessions__20260801T124121Z__c228db4-dirty.tsv`.

| Metric | Value |
|---|---|
| Sessions under test | 30 |
| Day-1 events | 1,994 |
| `VideoSessionEnd` present on day 1 | **0**, they are genuinely open |
| Day-1 asserted runs | 378 |
| Peak counted while still open | **62 over 99 minutes** |
| Absorption vs one-pass batch truth | **5,316 minutes, 0 diffs** |
| Sessions re-derived on arrival | 228 = 30 under test + 198 of 200 bystanders |

- [x] Each batch updates only affected sessions
- [x] Unaffected history not rebuilt
- [x] Earlier minutes not double-counted
- [x] Latest heartbeat extends activity
- [x] Backgrounding closes immediately
- [x] Resume creates a new interval
- [x] Session end finalizes
- [ ] Freshness SLA: not stated as a number

The 198-of-200 bystander figure is the honest one to quote: re-derivation is scoped to
sessions with events in the arrival window, not to the whole table.

---

## 10-12. Minute correctness, peak, average

Interval convention: **`[start, end)`**, half-open. `02_merge_runs.sql` subtracts one second
from the interval before computing covered minutes, so a run ending exactly on a minute
boundary does not claim the minute it never entered.

### Peak — PASS

Peak is computed **after** filtering, never read from a stored maximum. This is correct and
it matters: unfiltered traffic peaks at 10:56, live content peaks at 10:45.

| Grain | Result |
|---|---|
| Minute | works |
| Hour | works, and hour peak is the max of its minutes, not a sum |
| Day | 2,829 at 2026-07-26 10:56 |

### Average — FAIL

The definition is documented (mean of minute-level concurrency, including zero minutes) and
is the right definition. Both shipped queries implement it wrongly.

Measured over 2026-07-26, a full 1,440-minute day, unfiltered:

| Query | Minutes in denominator | Average | Error |
|---|---:|---:|---|
| `peak_average.sql` as shipped | 512 | **246.98** | **2.81x over-report** |
| `concurrency.sql` as shipped | 683 | **185.95** | **2.12x over-report** |
| Correct, densified over the window | 1,440 | **87.82** | baseline |

Two distinct root causes:

1. `peak_average.sql` has **no densification at all**. It averages only the minutes where a
   delta row happens to exist, so every quiet minute is skipped.
2. `concurrency.sql` uses `WITH FILL STEP toIntervalMinute(1)` with **no `FROM` / `TO`**.
   Bare `WITH FILL` only fills between the first and last existing row, so the series runs
   00:10 to 11:32 instead of 00:00 to 24:00. Leading and trailing empty minutes are never
   created.

Peak is unaffected in both cases — 2,829 either way. Only the average is wrong, and it is
wrong in the flattering direction, which is the dangerous one.

Fix: give `WITH FILL` explicit `FROM parseDateTimeBestEffort({from_ts:String}) TO
parseDateTimeBestEffort({to_ts:String})` in `concurrency.sql` and `user_concurrency.sql`,
and add the same densification to `peak_average.sql` before the `GROUP BY bucket`.

- [x] Peak over minute-level values
- [x] Filters applied before peak aggregation
- [x] Peak groupable by platform, country, content, and combinations
- [x] Peak reads the serving layer, not raw events
- [x] Average definition documented
- [ ] **Zero-concurrency minutes handled correctly — FAIL**
- [ ] **Partial first/last buckets handled correctly — FAIL**
- [x] Average supports the same filters as peak
- [x] No integer truncation, `round(..., 2)` on a float

---

## 13-14. Dimensions, filters, time grain

All required dimensions are filterable: `platform`, `country`, `content_id`, `video_type`,
`app_version`, plus time grain. `title`, `audio_language`, `subtitle_language`,
`player_version`, and `category` are **not** in the serving layer and would need a raw join.

Measured, `concurrency.sql`, 1-day window on 2026-07-26:

| Filter shape | ms | Rows read | Bytes | Result rows |
|---|---:|---:|---|---:|
| Time only | 8 | 26,904 | 210.19 KiB | 683 |
| Video type | 8 | 26,904 | 236.49 KiB | 683 |
| Content id | 9 | 26,904 | 420.38 KiB | 665 |
| Video type + app version | 9 | 26,904 | 117.48 KiB | 61 |
| Platform + country | 9 | **16,384** | 160.10 KiB | 682 |
| Platform + country + video type + content | 9 | **8,192** | 152.13 KiB | 665 |

The full serving table is 26,904 rows, so the worst case reads all of it and the best case
reads under a third. Leading-key filters prune as designed; a `content_id`-only filter does
not, because `content_id` sits fourth in the key. That is the documented cost of putting
dimensions ahead of `minute`, and it is the right trade at this size.

- [x] Metadata filters need no per-request raw join
- [x] Unknown metadata values remain queryable (`video_type` has an empty-string bucket)
- [x] Filters cannot multiply counts, `content` is unique
- [x] `ORDER BY` aligns with common filters
- [x] Adding a dimension has a documented trade-off
- [x] Hour peak is the max of underlying minutes
- [x] Day peak is the max of underlying minutes
- [ ] Hourly/daily **average** weighting inherits the densification defect above
- [x] Timezone pinned to UTC on both client and service

---

## 15-18. Serving layer, MVs, enrichment, performance

- [x] Dashboard reads a dedicated serving layer; **0 of the 6 measured serving queries
      touched `raw_events`**
- [x] Serving rows continuously updated by insert-time MVs
- [x] Open sessions and late events can revise buckets via sign retraction
- [x] No dimension explosion: 26,904 delta rows from 905,558 events
- [x] Deltas reconcile: **net sum exactly 0**, minimum running concurrency **0**, never
      negative
- [x] `FINAL` is not required on the dashboard path; `SummingMergeTree` is read with a
      `GROUP BY` that matches its key
- [x] All MVs healthy: every entry in `system.query_views_log` is `QueryFinish`, zero
      exceptions
- [x] `SummingMergeTree` is used only for `delta`, which is genuinely additive
- [x] `CollapsingMergeTree` sign balance holds (net 0 proves it)
- [x] Join key is `content_id`, LEFT JOIN so unmatched content never drops playback
- [x] 0 unmatched content ids
- [x] Latency measured, not guessed: 8-9 ms
- [x] Rows and bytes recorded
- [x] Service size recorded: ClickHouse Cloud, ap-south-1
- [ ] `EXPLAIN indexes = 1` plans not captured for the filter matrix
- [ ] No read budgets (`max_rows_to_read`) committed on any query

---

## 19-20. Scale and integration

Scale reasoning exists in the SQL comments and is sound — cost is proportional to interval
boundaries rather than watch time, corrections are additive rather than mutations, and no
dashboard query rescans history. But there is **no written scale document**, no row-growth
estimate, no merge-pressure analysis at 100x, and no retention or tiering strategy.

**ClickStack / Langfuse / LibreChat: NOT IMPLEMENTED.** A repo-wide search for
`clickstack|langfuse|librechat|hyperdx|otel|opentelemetry` returns only prose mentions in
`README.md`, `docs/ROADMAP.md`, `TASK.md`, and the problem statement. There is no code, no
config, no endpoint, no dependency. The checklist lists an absent integration as a standalone
FAIL condition, and it is worth 3 rubric points plus whatever the judges weight it at.

---

## 21. Scenario coverage

| ID | Scenario | Status | Basis |
|---|---|---|---|
| T01 | Normal play to end | PASS | oracle parity, 0 diffs |
| T02 | Start but never plays | PASS | `VideoSessionStart` is reactivating; documented ruling |
| T03 | Play, background, foreground | PASS | oracle parity |
| T04 | Background missing, heartbeat stops | PASS | tolerance cap closes it |
| T05 | Foreground missing, heartbeat resumes | PASS | neutral heartbeats cannot reopen |
| T06 | Duplicate heartbeat | PASS | millisecond collapse |
| T07 | Duplicate start | PASS | 13 multi-start sessions, still 1 run per minute |
| T08 | Out-of-order insert | PASS | ordering is by event time only |
| T09 | Late background event | PASS | sign retraction |
| T10 | Late session end | PASS | sign retraction |
| T11 | Open at day end | PASS | 5,316 minutes, 0 diffs |
| T12 | Error during play | PASS | `VideoError` is deactivating |
| T13 | One user, two sessions | PASS | sessions 2,829 vs users 2,749 |
| T14 | Session changes content | PASS | dims pinned to first event; 95 sessions affected, documented |
| T15 | Unknown content id | PASS | LEFT JOIN retains; 0 present in this corpus |
| T16 | Two events, same timestamp | PASS | `min()` collapse, close beats open, deterministic |
| T17 | Cross-midnight session | PASS | runs are timestamp-based, no day boundary logic |
| T18 | Long abandoned session | PASS | tolerance cap prevents indefinite counting |
| T19 | Replayed batch | PASS | open-session absorption test |
| T20 | Unseen-day file | PARTIAL | `FROZEN_BEFORE` parameterizes the slice, but no runbook exists |

Data quality on the frozen slice: 0 missing session ids, 0 missing user ids, 0 missing event
types, 0 zero `content_id`, 0 events before session start. 13 sessions have multiple starts
and 14 have multiple ends; neither inflates concurrency, verified.

---

## 22. Session vs user concurrency

Primary metric: **both**, reported separately and never mixed. Session concurrency comes
from `concurrency_deltas`, user concurrency from `user_concurrency_deltas`, and neither
query reads the other's table.

- [x] Metric labelled accurately in both queries
- [x] Multi-session users handled per metric
- [x] No `uniq(user_id)` shortcut anywhere in the session path
- [x] The two results are not mixed

---

## 24. Reproducibility

- [x] Objects recreated from version-controlled SQL (`sql/schema/`, `sql/pipeline/`)
- [x] Benchmark queries in version control (`sql/queries/benchmark/`)
- [x] Evidence artifacts committed with UTC timestamp and git sha in the filename
- [x] `evidence/LEDGER.tsv` maps every claim to a script and an artifact
- [x] Re-running is idempotent
- [x] Frozen slice is one parameter (`FROZEN_BEFORE`), not a literal scattered through SQL
- [ ] No unseen-day runbook
- [ ] `EXPLAIN` plans not exported
- [ ] Architecture diagram absent
- [ ] `naive_baseline_gate` sits at `FAIL` in the ledger, unresolved

---

## 26. Critical failure conditions

| Condition | Triggered |
|---|---|
| Counts every session start-to-end regardless of background | no |
| Counts stale sessions indefinitely | no |
| Scans all raw history per query | no, 0 serving queries touch raw |
| Rebuilds all history per heartbeat | no |
| Duplicates inflate concurrency | no |
| Out-of-order events permanently wrong | no |
| Open sessions cannot update served results | no |
| Peak calculated incorrectly across dimensions | no |
| Average has no documented definition | no, it is documented — but **implemented wrong** |
| Serving table cannot filter required dimensions | no |
| Works only for the supplied day | no, parameterized |
| ClickHouse not the primary engine | no, it is |
| **Required external integration absent** | **YES** |
| No query/pipeline evidence | no, evidence is strong |

One condition triggered: the missing integration.

---

## 27. Score

| Category | Weight | Score | Note |
|---|---:|---:|---|
| Foreground-only correctness | 25 | 23 | oracle parity at 0 diffs; neutral-heartbeat ruling is the strongest single decision here |
| Heartbeat and timeout correctness | 10 | 9 | tolerance cap correct; no separate abandoned-session timeout |
| Late/duplicate/out-of-order | 10 | 6 | mechanism proven, boundary undeclared |
| Open-session incremental updates | 10 | 9 | 0 diffs; no stated freshness SLA |
| Peak and average correctness | 10 | 4 | peak exact, average wrong in both queries |
| Filter and time-grain support | 10 | 9 | all grains correct; 5 source dimensions not served |
| Serving-layer query performance | 10 | 10 | 8-9 ms, never touches raw |
| ClickHouse schema/design quality | 5 | 5 | key inversion is deliberate and justified |
| 100x scalability explanation | 5 | 2 | reasoning in comments, no document |
| ClickStack/Langfuse/LibreChat | 3 | 0 | absent |
| Reproducibility and evidence | 2 | 2 | ledger and artifacts are exemplary |
| **Total** | **100** | **79** | mostly correct; targeted improvements needed |

Foreground and heartbeat correctness both pass, so the rubric's blocking clause does not
apply.

---

## 28. Review notes

### Done well

1. The neutral-heartbeat classification. Treating 41 of 49 heartbeat values as
   non-state-changing is the difference between a correct answer and a plausible one, and
   the error it avoids grows with the paused time being excluded.
2. Correctness is proven against an independent oracle rather than asserted, at 0 diffs on
   3,664 minutes, for both the session and user readings and both the batch and incremental
   paths.
3. The delta model's arithmetic is verifiable from outside: net sum exactly 0 and a running
   minimum of exactly 0 mean the sign bookkeeping is balanced and concurrency never goes
   negative.

### Risky

1. Average concurrency is over-reported by 2.1x to 2.8x in the two queries a dashboard would
   actually call. Peak is right, which makes the wrong number harder to notice.
2. No declared lateness boundary, so no bucket is ever formally final.
3. `foreground_intervals` stores second-resolution timestamps, making 42% of intervals
   zero-length. Harmless at minute grain, but it fails a literal reading of the interval
   invariant and will cost time to re-explain under review.

### Missing

1. The external integration, entirely.
2. An unseen-day runbook.
3. A written scale document with row-growth and merge-pressure estimates.

### Required before submission

| Priority | Fix |
|---|---|
| P0 | Add `FROM`/`TO` to `WITH FILL` in `concurrency.sql` and `user_concurrency.sql` |
| P0 | Add densification to `peak_average.sql` before the bucket `GROUP BY` |
| P0 | Implement one of ClickStack / Langfuse / LibreChat against the real serving layer |
| P1 | Declare a lateness boundary and count events that exceed it |
| P1 | Write the unseen-day runbook, end to end |
| P1 | Resolve or retire the `naive_baseline_gate` FAIL row in the ledger |
| P2 | Capture `EXPLAIN indexes = 1` for the filter matrix |
| P2 | Commit read budgets (`max_rows_to_read`) on serving queries |
| P2 | Store intervals as `DateTime64`, or document the point-interval convention |

---

## 29. Sign-off

**APPROVED WITH CONDITIONS.** The concurrency engine is correct and its correctness is
proven rather than claimed. Two defects block submission: the average denominator, which is
a small and mechanical fix, and the missing external integration, which is not.
