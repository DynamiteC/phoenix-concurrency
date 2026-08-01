# SonyLIV ClickHouse: 30-minute manual validation runbook, filled

Independent execution of `sonyliv_30_minute_manual_sql_validation_runbook.md` against the live
`phoenix` service. Every row below was run, or is answered by a committed evidence artifact
named in the Notes column. Rows nobody ran are marked `NOT RUN` rather than inferred.

**Where these numbers come from.** Every figure measured for this review is committed to
`evidence/runbook_validation__20260801T145408Z__0ef547d-dirty.tsv`, reproducible with
`./scripts/runbook_validation.sh`, and carries a ledger row (`runbook_validation`). Figures that
were already covered by an earlier artifact cite it inline as `[V:<id>]`. Nothing in this document
is an untagged measurement.

| Field | Value |
|---|---|
| Reviewer | Implementer self-validation, for team-lead review |
| Validation date | 2026-08-01 14:43 UTC |
| ClickHouse version | 26.2.1.525 (Cloud, ap-south-1) |
| Database | `phoenix` |
| Frozen corpus predicate | `event_timestamp < '2026-08-01'` |
| Git commit / branch | `d4f2906` on `feature/evidence-and-live-demo` |

**Headline: 35 PASS, 4 PARTIAL, 7 FAIL, 1 finding, 1 absent.**

The 7 failing checks are 29, 30, 34, 42, 44, 46, 47. They cluster into 3 root causes: the
corrected average is written but not wired into the demo (29, 30, and half of 31), the external
integration is unstarted (44), and a set of submission-readiness items is untouched (34, 42, 46,
47, 48). Test 43 is recorded as its own category because it is a proven finding rather than a
pass or a fail. Test 48 was never run and the safeguards it looks for are absent.

None of the 7 is a defect in the concurrency logic itself. Test 17 is the only check that touches
that logic and it is a PARTIAL, with a measured ceiling. Counting checks rather than themes here
deliberately: an earlier draft of this line said "3 FAIL" by counting root causes, which
understated the table below.

---

## Phase 1: environment and objects

| # | Check | Status | Actual |
|---|---|---|---|
| 1 | ClickHouse version | PASS | `26.2.1.525` |
| 2 | Object inventory | PASS | All expected objects present, 15 in `phoenix`. Note `event_state` is a plain `View`, not a table, by design: it is the shared state machine evaluated on read. `[V:inventory_phoenix]` |
| 3 | Engines, sort keys, partitions | PASS | Landing is `Null`; runs tables are `SharedCollapsingMergeTree(sign)`; serving is `SharedSummingMergeTree(delta)`; `raw_events` is `PARTITION BY toYYYYMMDD(event_timestamp)`; serving `ORDER BY (platform, country, video_type, content_id, app_version, minute)`. Cloud substitutes `Shared*` for every `*MergeTree` in `sql/schema/`, which is why `SHOW CREATE TABLE` does not match the DDL files |
| 4 | Materialized-view health | PASS | Zero exceptions. `raw_events_mv` x835, `concurrency_deltas_mv` x86, `user_concurrency_deltas_mv` x60, all `QueryFinish` |

## Phase 2: source data

| # | Check | Status | Actual |
|---|---|---|---|
| 5 | Raw schema | PASS | All 13 expected columns present, correct types. One extra: `ingested_at DateTime DEFAULT now()`, added out-of-band by `ALTER` and **not** in the committed DDL. See test 43 |
| 6 | Frozen-corpus volume | PASS | Rows **905,558**, sessions **10,866**, users **9,618**, contents **3,357**. Matches all four expected values exactly. Span `2026-07-14 15:43:58.144` to `2026-07-26 11:30:04.847` |
| 7 | Event-type distribution | PASS | All 7 expected event types present. 47 distinct `event` values in the frozen slice (`docs/ROADMAP.md` said 46; 47 is measured). Two further values appear only in the live August slice, both classified conservatively `[V:unknown_vocabulary]` |
| 8 | Content volume and uniqueness | PASS | **33,464** rows and **33,464** unique IDs, matching expected. `count() FINAL` also 33,464, so no unmerged duplicates are hiding behind the `ReplacingMergeTree` |
| 9 | Duplicate content IDs | PASS | **0** duplicate groups |
| 10 | Content enrichment completeness | PASS | **0** unmatched rows, **0** unmatched IDs |

## Phase 3: data quality and deduplication

| # | Check | Status | Actual |
|---|---|---|---|
| 11 | Required-field quality | PASS | All five counters **0**: no missing session, user or event type, no zero `content_id`, no event before `session_start_epoch` |
| 12 | Duplicate source events | PASS | **3,413** groups, **4,210** excess rows. Matches expected exactly. Neutralised at read time by `event_state`, which collapses to one row per `(video_session_id, millisecond)` before deriving state |
| 13 | Multiple starts and ends | PASS | **13** multiple starts, **14** multiple ends, **0** missing start, **0** missing end. Matches all four expected values exactly |
| 14 | Sessions with changing dimensions | PASS | **95** multi-platform, **120** multi-user, **1** multi-content. Pinning verified deterministic: `sql/pipeline/01_derive_intervals.sql:23-27` uses `argMin(<dim>, event_timestamp)`, so the earliest event wins and the result does not depend on scan order |

## Phase 4: foreground state logic

| # | Check | Status | Actual |
|---|---|---|---|
| 15 | State-machine definition | PASS | Ordered by `event_timestamp`, not ingestion order. Duplicates collapse before state derivation. Closing bucket: `AppBackgrounded`, `VideoSessionEnd`, `VideoError`, plus `VideoHeartbeat` in (`pause`, `speed-pause`, `AdPause`). Opening bucket: `VideoSessionStart`, `VideoPlay`, `AppForegrounded`, plus (`resume`, `speed-resume`, `AdResume`). Everything else is neutral and carries the previous state forward, so a neutral heartbeat cannot reopen a paused session. Close beats open at the same millisecond. Tolerance cap is 90s, chosen from the observed gap distribution (p90 40s, p99 76s) |
| 16 | Event classification visibility | PASS | Classification is derivable from the view definition and enumerated by `scripts/vocabulary_check.sh`, which reports any value the classifier does not recognise `[V:unknown_vocabulary]`. Neutral-heartbeat behaviour confirmed in test 15 |
| 17 | Intervals after known session end | **PARTIAL** | **385**, not the expected 0. Concentrated in **21 sessions** of 10,866 (0.19%); 336 of the 385 exceed the 90s tolerance tail, so the tail does not fully explain it. Root cause is dirty data the runbook itself measures: 14 sessions emit more than one `VideoSessionEnd` (test 13), and 239 sessions carry events after their last end event. Our state machine reopens on a subsequent `VideoPlay`, which counts that later playback as viewing. **Ceiling on the damage, stated as a bound rather than a measurement: peak is 2,829 with these sessions and 2,827 with all 21 excluded entirely, so at most 2 sessions at peak (0.07%).** That is an upper bound because excluding a session removes its legitimate pre-end viewing too. Overshoot max 2,171s. **The effect on the corpus average is not measured**, and with a median overshoot of 760s across 385 intervals it will not be exactly zero. Recommend the lead rule on which reading is wanted: honour the first end event, or count observed playback after it |
| 18 | Backwards and zero-length intervals | PASS (P2 noted) | **0** backwards. **253,590 of 599,137 zero-length (42.3%)**, from second-resolution storage against a millisecond state machine. No output effect: `timeSlots(t, 0, 60)` returns exactly one slot, so a zero-length interval contributes exactly one minute, which is correct |
| 19 | Overlapping session runs | PASS | **0** overlaps |
| 20 | Maximum one run per session-minute | PASS | **1**, as expected. This is the no-double-count proof |

## Phase 5: serving-layer integrity

| # | Check | Status | Actual |
|---|---|---|---|
| 21 | Session delta balance | PASS | `sum(delta)` = **0** |
| 22 | User delta balance | PASS | `sum(delta)` = **0** |
| 23 | Session concurrency invariants | PASS | Minimum **0**, peak **2,829**. Both as expected. Minimum 0 proves the deltas balance in order, not merely in total |
| 24 | User concurrency invariants | PASS | Minimum **0**, peak **2,749**. Both as expected |
| 25 | Session versus user peak | PASS | Session **2,829**, user **2,749**, difference **80**. Matches expected exactly |

## Phase 6: peak and average correctness

| # | Check | Status | Actual |
|---|---|---|---|
| 26 | Correct global peak | PASS | Peak **2,829** at **2026-07-26 10:56:00**, as expected |
| 27 | Filter-aware peak | PASS | Peak is computed after filtering. Asserted by `sql/queries/serving/test_peak_is_not_a_rollup.sql`: max per-platform peak 1,743, sum of per-platform peaks 2,918, overall 2,829, so the overall peak is neither the max nor the sum `[V:peak_not_a_rollup]` |
| 28 | Densified full-day average | **PARTIAL: the reference query is biased low** | Run verbatim it returns **87.82** over denominator **1,440**. That denominator is right and the average is not. `curve` holds one row per minute that has a delta, and **928 of the 1,440 minutes on 2026-07-26 have no delta row**; for those the `LEFT JOIN` yields no match and `ifNull(c.concurrency, 0)` scores them **0** instead of carrying the standing concurrency forward. An independent last-observation-carried-forward reference (`ASOF LEFT JOIN`, no shared code with our serving SQL) returns **88.2** over the same 1,440 minutes, with peak 2,829 and 635 minutes with audience. **88.2 is the correct full-day average; 87.82 under-reports by 0.38.** Our `sql/queries/serving/peak_average.sql` returns 88.2, matching the independent reference exactly |
| 29 | Repository `concurrency.sql` | **FAIL as shipped** | Reproduces the prior failure signature exactly: first row **00:10**, last row **11:32**, **683** rows, average **185.95**. `sql/queries/benchmark/concurrency.sql:55` still uses bare `WITH FILL STEP toIntervalMinute(1)` with no `FROM`/`TO`, so the fill spans only existing rows and the average is taken over sparse ones |
| 30 | Repository `peak_average.sql` | **FAIL as shipped** | `benchmark/peak_average.sql` returns average **246.98** with the correct peak of 2,829, exactly the prior signature. The corrected `sql/queries/serving/peak_average.sql` returns **88.2 over denominator 1,440**, matching the independent LOCF reference in test 28 (not the runbook's own test 28 query). **The fix exists and is not wired: `demo/server.js:22-23` still loads the `benchmark/` files.** **A consequence you need to rule on:** test 29's printed pass criterion is "average matches Test 28", and test 28 as written returns 87.82 while the corrected query returns 88.2. By the criterion exactly as specified, 29 and 30 can never pass. Adopting the fix requires accepting the corrected reference of 88.2 |
| 31 | Bounded `WITH FILL` | **PARTIAL** | Present and correct in both `sql/queries/serving/*.sql` (explicit `FROM`/`TO`/`STEP`, plus a `seeded_window` CTE so a window opening mid-session starts from the true standing concurrency rather than 0). Still absent from all four `sql/queries/benchmark/*.sql`, which is what the demo serves |

## Phase 7: filter coverage

| # | Check | Status | Actual |
|---|---|---|---|
| 32 | Serving columns | PASS | All seven expected columns present: `minute`, `platform`, `country`, `video_type`, `content_id`, `app_version`, `delta` |
| 33 | Dimension-value quality | **PARTIAL** | No aliasing found: platforms are a single clean vocabulary (`ANDROID_PHONE`, `IPHONE`, `SONY_ANDROID_TV`, `JIO_ANDROID_TV`, `FIRE_TV`, `XIAOMI_ANDROID_TV`, `LG_HTML_TV`, `Mweb`, `ANDROID_TAB`, `SAMSUNG_HTML_TV`), so no `ANDROID_PHONE`/`android` or `FIRE_TV`/`firetv` pair exists. `country` holds exactly one value, `india`, so no `IN`/`india` pair either. **One finding the runbook did not anticipate: `video_type` includes an empty string** alongside `vod` and `live`, from the deliberate `LEFT JOIN` to `content` that keeps playback whose metadata is missing. Correct behaviour, but it needs a dashboard label |
| 34 | Title and category support | **FAIL** | Neither is carried in `concurrency_deltas`. `phoenix.content` has both (`sql/schema/02_content.sql:12,14`); the serving table carries `content_id` only. A title or category filter needs an added dimension or a join. Confirms the prior review finding |

## Phase 8: performance

| # | Check | Status | Actual |
|---|---|---|---|
| 35 | Flush query logs | PASS | Run |
| 36 | Query latency and reads | PASS | **10-15 ms** cold, 11-12 ms warm; **16,384 to 26,904** rows read. Inside the expected 8-9 ms / 8,192-26,904 envelope on rows, marginally above on milliseconds `[V:filter_shapes]` |
| 37 | Dashboard does not scan raw events | PASS, with a caveat about the check | The literal query returns **185**, not 0, but none of those is a dashboard query: 183 are `ground_state.sh` invariant queries reading `raw_events` + the runs tables, 1 is the naive-baseline build, 1 is an interval check. The runbook's `ILIKE '%concurrency%'` heuristic cannot distinguish a validation query from a serving one. Scoped properly, `raw_events` appears in no serving-query plan. Read back from `system.query_log` across all replicas, the serving query's own entry is `tables = phoenix.concurrency_deltas` and `read_rows = 26,904`: the serving path reads exactly one table, and the figure matches the committed `[V:filter_shapes]` claim. (An intermediate reading of 49,049 rows with `session_minute_runs` attached turned out to be a different query on another replica, not the serving query. A single-replica `query_id` lookup misses these entries; `clusterAllReplicas(default, system.query_log)` is required) |
| 38 | Explain index pruning | PASS | Pruning visible. `platform` filter yields `granules 2/4`; unfiltered is `4/4` |
| 39 | Compare filter shapes | PASS, honestly qualified | Unfiltered **26,904** rows / 4 marks. `platform` **16,384** / 2 marks. `platform+country` **16,384** / 2. `content+platform` **16,384** / 2. The pass condition holds for leading-key filters. **Stated plainly: only `platform` prunes**, because it leads the sort key. `country`, `video_type`, `content_id` and `app_version` each read the full 26,904 on their own. At 60 KiB that is a rounding error; at 100x it is the first thing to revisit, most likely with a content-first projection |

## Phase 9: incremental and late corrections

| # | Check | Status | Actual |
|---|---|---|---|
| 40 | Physical sign rows | PASS | `sign = -1`: **1,498** rows; `sign = +1`: **20,647**. Both present, so retractions are being stored rather than applied. Logical result stays correct because every consumer uses `sum(sign)` or `FINAL`, never bare `count()` |
| 41 | Verify correction path | PASS | `sign = -1` retracts the previously asserted runs of a touched session, `sign = +1` re-asserts. `concurrency_deltas_mv` emits `d.2 * sign`, so a retraction automatically emits the inverse delta pair and a revised run cancels itself with no bookkeeping. Nothing expects an MV to reread changed source rows. Verified against one-pass batch truth `[V:open_sessions]` and attributed to exactly the sessions that received events `[V:open_session_update]` |
| 42 | Lateness boundary | **FAIL** | No formal boundary, no quarantine, no dead-letter path. Confirms the prior review finding. Compounded by test 43: the column that would measure lateness cannot be trusted |
| 43 | Ingestion timestamp safety | **Not a safe watermark, proven** | `ingested_at DateTime DEFAULT now()` was added by `ALTER` after the July rows were loaded. ClickHouse does not rewrite existing parts, so for those rows the default is evaluated **at read time** and the column equals the reading query's own clock: measured three times four seconds apart, `uniqExact` returned 1 each time with a different value. Applying `ingested_at <= now()` retained **0 of 905,558** July rows and **all** August rows, the exact inversion of intent `[V:ingested_at_nondeterminism]`. The freeze key is `event_timestamp`, a stored value in both slices, injected as one parameter by `scripts/ch.sh`. This is stronger than the runbook's caution and should be read as a finding, not a clearance |

## Phase 10: submission readiness

| # | Check | Status | Actual |
|---|---|---|---|
| 44 | External integration | **FAIL** | Absent. No ClickStack, HyperDX, Langfuse, LibreChat, OpenTelemetry, OTEL or MCP code or config anywhere in the tree. Only prose: `README.md:24` states the requirement, `TASK.md:298` records it as unstarted. This is a hard submission requirement and the single largest risk |
| 45 | Reproducibility files | PASS | `scripts/init_db.sh` present and working; `scripts/load.sh` present, and it compares source rows against loaded rows on every run so a quoting error cannot lose rows silently; numbered pipeline SQL `sql/pipeline/01-04`; benchmark SQL present; 27 evidence artifacts; **unseen-day runbook exists** at `docs/RUNBOOK_UNSEEN_DAY.md`, rehearsed end to end on a throwaway database with per-step wall clock `[V:runbook_rehearsal]` |
| 46 | Evidence ledger | **FAIL** | 18 claims, all mapping to a script and an artifact, all carrying a git SHA and UTC timestamp; `scripts/check_docs.sh` passes all four of its gates. But **two unresolved `FAIL` rows remain**: (a) `naive_baseline_gate` is **stale** and should be retired: the gate was rewritten to clip to the overlapping range and now records `naive_baseline` = `PASS` with `minutes_excluded_by_clip=1`; (b) `derive_idempotence` is a **real, deliberately recorded failure**: running the batch derive twice doubles concurrency, and the artifact documents which invariants catch it and which do not. It is a guard-rail finding rather than a serving-path defect, but it is genuinely open. On status convention, since this check is about ledger hygiene: `PASS` and `FAIL` mark a gate with a pass criterion, `RECORDED` marks an observation whose artifact carries mixed results. The `runbook_validation` row added for this review is `RECORDED` on that basis: its artifact holds both the passing invariants and the failures at tests 17, 29 and 30 |
| 47 | TTL and retention | **FAIL** | No TTL on `raw_events`, `foreground_intervals`, `session_minute_runs` or `concurrency_deltas`. No retention documented |
| 48 | Query safeguards | NOT RUN → absent | No `max_rows_to_read`, `max_bytes_to_read`, `max_execution_time` or `readonly` on any dashboard query. `TASK.md:243` plans per-query read budgets; none is applied today |

---

## Blocking checks

| Requirement | Status |
|---|---|
| Foreground/background logic | **PARTIAL** (test 17: 385 intervals past a session end, 21 sessions, 2-session peak impact) |
| Heartbeat timeout | PASS (90s, chosen from the measured gap distribution) |
| Duplicate neutralization | PASS (3,413 groups collapsed before state derivation) |
| No negative concurrency | PASS (`min_concurrency` = 0, session and user) |
| Peak correctness | PASS (2,829 at 10:56, computed after filtering, proven not a rollup) |
| Average correctness | **FAIL as wired** (demo serves 246.98; the corrected query returns 88.2, and 88.2 is confirmed by an independent reference) |
| Dashboard uses serving layer | PASS (`concurrency_deltas` only; `raw_events` in no serving plan) |
| Open/late correction path | PASS for corrections, **FAIL for a lateness boundary** (tests 41 vs 42) |
| External integration | **FAIL** (absent) |
| Unseen-day reproducibility | PASS (runbook exists and was rehearsed end to end) |

## Decision

Applying the runbook's own decision rule: the required external integration is absent, and the
average is wrong on the path the demo actually serves. **The rule yields REWORK REQUIRED**, and
that is what this document reports.

`docs/review/REPLY.md` argues that **APPROVED WITH CONDITIONS** is the better reading, on the
grounds that the engine is correct and independently checkable, that the two blocking failures are
a two-line wiring change and one unstarted deliverable, and that the one blocking PARTIAL inside
the concurrency logic (test 17) is a definition question with a measured ceiling of 2 sessions at
peak. That is an argument for the lead to accept or reject, not a verdict we award ourselves.

## Required fixes tracker

| Priority | Fix | Status |
|---|---|---|
| P0 | Wire `demo/server.js:22-23` to `sql/queries/serving/*.sql` | Fix written, not wired |
| P0 | Implement ClickStack / Langfuse / LibreChat | Not started |
| P1 | Rule on test 17: honour first session end, or count playback after it | Awaiting decision |
| P1 | Define and measure a lateness boundary; add an explicitly-written arrival column first | Not started |
| P1 | Retire the stale `naive_baseline_gate` ledger row; resolve or accept `derive_idempotence` | Open |
| P1 | Bound `WITH FILL` in `sql/queries/benchmark/*.sql`, or retire those files | Open |
| P2 | Title / category support in the serving table | Not started |
| P2 | Explain the 49,049-row query_log attribution in test 37 | Open |
| P2 | TTL and retention; per-query read budgets | Not started |
| P2 | Label the empty `video_type` in the dashboard | Open |

## Sign-off

```text
[ ] APPROVED
[ ] APPROVED WITH CONDITIONS     <- implementer's recommendation, see REPLY.md
[x] REWORK REQUIRED              <- what your decision rule yields on these results
[ ] REJECTED
```

| Role | Name | Date | Approval |
|---|---|---|---|
| Implementer | | 2026-08-01 | Submitted for review |
| Reviewer | | | |
| Team lead | | | |
