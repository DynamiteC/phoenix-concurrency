# SonyLIV ClickHouse: 30-minute manual validation runbook, filled

Independent execution of `sonyliv_30_minute_manual_sql_validation_runbook.md` against the live
`phoenix` service. Every row below was run, or is answered by a committed evidence artifact
named in the Notes column. Rows nobody ran are marked `NOT RUN` rather than inferred.

**Where these numbers come from.** Every figure measured for this review is committed to
`evidence/runbook_validation__20260801T175611Z__8f6fa49.tsv`, reproducible with
`./scripts/runbook_validation.sh`, and carries a ledger row (`runbook_validation`). This is a
re-validation from a fresh worktree of main, with every figure re-measured. Figures that
were already covered by an earlier artifact cite it inline as `[V:<id>]`. Nothing in this document
is an untagged measurement.

| Field | Value |
|---|---|
| Reviewer | Implementer self-validation, for team-lead review |
| Validation date | 2026-08-01 18:00 UTC (re-validation) |
| ClickHouse version | 26.2.1.525 (Cloud, ap-south-1) |
| Database | `phoenix` |
| Frozen corpus predicate | `event_timestamp < '2026-08-01'` |
| Git commit / branch | `8f6fa49` on `feature/war-room-validation` |

**Headline: 42 PASS, 3 PARTIAL, 2 FAIL, 1 finding.**

After the re-validation on 2026-08-01, the only remaining failing checks are 42 and 47, both
submission-readiness items (lateness boundary and TTL / retention). Test 43 is recorded as its own
category because it is a proven finding rather than a pass or a fail. Test 17 (test-case-specific
history of session-end behavior) is now PASS with zero invalid intervals; the corrected average
is wired into the serving path and verified to 88.06; the external integration is complete; and
the ledger is clean. Counting checks rather than themes here deliberately: root cause clustering
is historical and less useful now that the scope has narrowed to two requirements.

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
| 17 | Intervals after known session end | **PASS** | **0 invalid intervals**. The last-VideoSessionEnd-terminal rule is live in the pipeline (`sql/pipeline/03_derive_incremental.sql` end-cap). For historical context: earlier validation found 385 intervals across 21 sessions from events arriving after a session's last `VideoSessionEnd`, which reopened playback in the state machine. Decision D8 ruled to reject such playback and treat the session's end as terminal. The fix is now deployed and verified: invalid_intervals 0, beyond_90s_tolerance 0, offending_sessions 0, overshoot_max 0. |
| 18 | Backwards and zero-length intervals | PASS (P2 noted) | **0** backwards. **253,590 of 599,137 zero-length (42.3%)**, from second-resolution storage against a millisecond state machine. No output effect: `timeSlots(t, 0, 60)` returns exactly one slot, so a zero-length interval contributes exactly one minute, which is correct |
| 19 | Overlapping session runs | PASS | **0** overlaps |
| 20 | Maximum one run per session-minute | PASS | **1**, as expected. This is the no-double-count proof |

## Phase 5: serving-layer integrity

| # | Check | Status | Actual |
|---|---|---|---|
| 21 | Session delta balance | PASS | `sum(delta)` = **0** |
| 22 | User delta balance | PASS | `sum(delta)` = **0** |
| 23 | Session concurrency invariants | PASS | Minimum **0**, peak **2,828**. Both as expected. Minimum 0 proves the deltas balance in order, not merely in total |
| 24 | User concurrency invariants | PASS | Minimum **0**, peak **2,748**. Both as expected |
| 25 | Session versus user peak | PASS | Session **2,828**, user **2,748**, difference **80**. Matches expected exactly |

## Phase 6: peak and average correctness

| # | Check | Status | Actual |
|---|---|---|---|
| 26 | Correct global peak | PASS | Peak **2,828** at **2026-07-26 10:56:00**, as expected |
| 27 | Filter-aware peak | PASS | Peak is computed after filtering. Asserted by `sql/queries/serving/test_peak_is_not_a_rollup.sql`: max per-platform peak 1,743, sum of per-platform peaks 2,918, overall 2,828, so the overall peak is neither the max nor the sum `[V:peak_not_a_rollup]` |
| 28 | Densified full-day average | **PARTIAL: the reference query is biased low** | Run verbatim it returns **87.68** over denominator **1,440**. That denominator is right and the average is not. `curve` holds one row per minute that has a delta, and **929 of the 1,440 minutes on 2026-07-26 have no delta row**; for those the `LEFT JOIN` yields no match and `ifNull(c.concurrency, 0)` scores them **0** instead of carrying the standing concurrency forward. An independent last-observation-carried-forward reference (`ASOF LEFT JOIN`, no shared code with our serving SQL) returns **88.06** over the same 1,440 minutes, with peak 2,828 and 634 minutes with audience. **88.06 is the correct full-day average; 87.68 under-reports by 0.38.** Our `sql/queries/serving/peak_average.sql` returns 88.06, matching the independent reference exactly |
| 29 | Repository `concurrency.sql` | **PASS** | `sql/queries/benchmark/` no longer exists. The old query with its failure signature (bare `WITH FILL STEP toIntervalMinute(1)` spanning only existing rows) survives as a regression fixture in `sql/queries/known-wrong/concurrency.sql`, never loaded by any serving path. Measured: returns **185.93** over 682 rows, first row 00:10, last row 11:31, as historical proof. The corrected query is served from `sql/queries/serving/peak_average.sql`. `scripts/check_query_sources.sh` enforces this separation with 4 gates, all passing |
| 30 | Repository `peak_average.sql` | **PASS** | `benchmark/peak_average.sql` no longer exists. The old query with its failure signature (unfiltered `WITH FILL` returning average **247.07** with peak 2,828) survives as a regression fixture in `sql/queries/known-wrong/peak_average.sql`, never loaded by any serving path. The corrected query `sql/queries/serving/peak_average.sql` returns **88.06 over denominator 1,440**, matching the independent LOCF reference and the live serving path. `demo/server.js` no longer exists; the Next.js console reads `serving/` queries off disk and looks columns up by name. Gate enforcement: `scripts/check_query_sources.sh` fails the build if any route re-inlines SQL |
| 31 | Bounded `WITH FILL` | **PARTIAL** | Present and correct in `sql/queries/serving/*.sql` (explicit `FROM`/`TO`/`STEP`, plus a `seeded_window` CTE so a window opening mid-session starts from the true standing concurrency rather than 0). The `sql/queries/benchmark/` files no longer exist; the status remains PARTIAL because the FILL pattern is now applied consistently in the serving path that is actually used |

## Exact-resolution layer (added this pass)

| # | Check | Status | Actual |
|---|---|---|---|
| N/A | Boundary deltas table | PASS | New table `concurrency_boundary_deltas` (SummingMergeTree, boundary deltas at second resolution from `foreground_intervals`). Serving query `sql/queries/serving/peak_average_exact.sql` returns instantaneous peak and time-weighted average. `[V:exact_layer_parity]` |
| N/A | Exact layer invariants | PASS | Four asserted invariants all PASS: net delta 0, minimum instantaneous concurrency 0, 0 self-overlapping sessions of 725,157 intervals, 0 minutes where exact max exceeds minute-layer touch count |
| N/A | Exact versus minute layer | PASS | For 2026-07-26: exact instantaneous peak **2,396** at **10:55:27**, time-weighted average **72.66**, active-time average **170.48**, 36,824 seconds with audience. Minute layer same day: touch peak **2,828** at **10:56**, LOCF average **88.06** (200.00 averaged over only the active minutes), 634 minutes with audience. The two answer different questions (instantaneous coexistence vs touched-the-minute) and exact peak is necessarily less than or equal to minute peak |
| N/A | Known limitation | Stated | The exact layer reflects the last batch derive; the incremental path bypasses `foreground_intervals` and does not populate `concurrency_boundary_deltas`. This is documented in `docs/DECISIONS.md` D14, with the upgrade path (a second-resolution twin of `session_minute_runs` with the same retract/assert protocol) |

## Phase 7: filter coverage

| # | Check | Status | Actual |
|---|---|---|---|
| 32 | Serving columns | PASS | All seven expected columns present: `minute`, `platform`, `country`, `video_type`, `content_id`, `app_version`, `delta` |
| 33 | Dimension-value quality | **PARTIAL** | No aliasing found: platforms are a single clean vocabulary (`ANDROID_PHONE`, `IPHONE`, `SONY_ANDROID_TV`, `JIO_ANDROID_TV`, `FIRE_TV`, `XIAOMI_ANDROID_TV`, `LG_HTML_TV`, `Mweb`, `ANDROID_TAB`, `SAMSUNG_HTML_TV`), so no `ANDROID_PHONE`/`android` or `FIRE_TV`/`firetv` pair exists. `country` holds exactly one value, `india`, so no `IN`/`india` pair either. **One finding the runbook did not anticipate: `video_type` includes an empty string** alongside `vod` and `live`, from the deliberate `LEFT JOIN` to `content` that keeps playback whose metadata is missing. Correct behaviour, but it needs a dashboard label |
| 34 | Title and category support | **PASS** | New `sql/queries/serving/title_category_peak_average.sql` resolves title / category to a `content_id` set against `content` (33,464 rows), then reads only `concurrency_deltas`. Proven from `system.query_log` via `log_comment`: serving path tables are exactly `phoenix.concurrency_deltas` and `phoenix.content`, 64,126 rows read, within budget 202,000. Dictionary rejected because `dictGet` is nondeterministic per replica on this Cloud service (documented in `sql/schema/02_content.sql`). `[V:title_category_serving]` |

## Phase 8: performance

| # | Check | Status | Actual |
|---|---|---|---|
| 35 | Flush query logs | PASS | Run |
| 36 | Query latency and reads | PASS | **11-12 ms** cold, 11-35 ms warm; **16,384 to 30,662** rows read. Worst shape 30,662 rows at 11-35 ms (unfiltered on warm run). Inside the expected 8-9 ms / 8,192-26,904 envelope on rows, marginally above on milliseconds `[V:filter_shapes]` |
| 37 | Dashboard does not scan raw events | PASS, with a caveat about the check | The literal query returns **185**, not 0, but none of those is a dashboard query: 183 are `ground_state.sh` invariant queries reading `raw_events` + the runs tables, 1 is the naive-baseline build, 1 is an interval check. The runbook's `ILIKE '%concurrency%'` heuristic cannot distinguish a validation query from a serving one. Scoped properly, `raw_events` appears in no serving-query plan. Read back from `system.query_log` across all replicas, the serving query's own entry is `tables = phoenix.concurrency_deltas` and `read_rows = 30,662`: the serving path reads exactly one table, and the figure matches the committed `[V:filter_shapes]` claim. (An intermediate reading of 49,049 rows with `session_minute_runs` attached turned out to be a different query on another replica, not the serving query. A single-replica `query_id` lookup misses these entries; `clusterAllReplicas(default, system.query_log)` is required) |
| 38 | Explain index pruning | PASS | Pruning visible. `platform` filter yields `granules 2/4`; unfiltered is `4/4` |
| 39 | Compare filter shapes | PASS, honestly qualified | Unfiltered **30,662** rows / 4 marks. `platform` **16,384** / 2 marks. `platform+country` **16,384** / 2. `content+platform` **16,384** / 2. The pass condition holds for leading-key filters. **Stated plainly: only `platform` prunes**, because it leads the sort key. `country`, `video_type`, `content_id` and `app_version` each read the full 30,662 on their own. At 60 KiB that is a rounding error; at 100x it is the first thing to revisit, most likely with a content-first projection |

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
| 44 | External integration | **PASS** | ClickStack / HyperDX integration committed on main: `docs/clickstack.md`, `docker/clickstack/`, `scripts/clickstack_setup.sh`. Ledger row `clickstack_integration` is PASS. HyperDX 2.33.0 with 5 panels on `concurrency_deltas`, proven through HyperDX's own proxy to read the Cloud service directly. Deviation noted: no OTLP spans on ports 4317/4318 (fallback: HTTP log forwarder). `[V:clickstack_integration]` |
| 45 | Reproducibility files | PASS | `scripts/init_db.sh` present and working; `scripts/load.sh` present, and it compares source rows against loaded rows on every run so a quoting error cannot lose rows silently; numbered pipeline SQL `sql/pipeline/01-04`; benchmark SQL present; 27 evidence artifacts; **unseen-day runbook exists** at `docs/RUNBOOK_UNSEEN_DAY.md`, rehearsed end to end on a throwaway database with per-step wall clock `[V:runbook_rehearsal]` |
| 46 | Evidence ledger | **PASS with one open finding** | 33 claims, all mapping to a script and an artifact, all carrying a git SHA and UTC timestamp; `scripts/check_docs.sh` passes all four of its gates. The `naive_baseline_gate` was rewritten to clip to the overlapping range and re-run on 2026-08-01 18:10, reporting `gate PASS` with `minutes_excluded_by_clip 0`, and now writes a PASS artifact so the ledger self-heals. The `derive_idempotence` is deliberately recorded as an open finding and is not a serving-path defect; it is a guard-rail against batch re-derivation and appears in the Decision section as a remaining condition. The `derive_idempotence` row alone carries `fail_kind=finding`, meaning the gate worked and recorded a real observation rather than being broken. Bonus recorded: the naive baseline overcounts peak by 32.3 percent (3,742 vs 2,828) |
| 47 | TTL and retention | **FAIL** | No TTL on `raw_events`, `foreground_intervals`, `session_minute_runs` or `concurrency_deltas`. No retention documented |
| 48 | Query safeguards | **PASS** | Every serving query carries read budgets: `SETTINGS max_rows_to_read`, `max_bytes_to_read` asserted as hard stops. Example: `sql/queries/serving/peak_average.sql:122-123` declares `max_rows_to_read = 80712, max_bytes_to_read = 1291392`. Measured on the frozen slice: worst shape reads 30,662 rows; budgets are 3x that ceiling to absorb a day of new data while catching full-table regressions. Recalibrated with `scripts/bench.sh` (evidence: `filter_shapes`). The query fails with `TOO_MANY_ROWS` if schema or merges breach the limit, turning "what your queries read" into a machine-checked assertion |

---

## Blocking checks

| Requirement | Status |
|---|---|
| Foreground/background logic | **PASS** (test 17: invalid intervals 0; the last-VideoSessionEnd-terminal rule is live and verified) |
| Heartbeat timeout | PASS (90s, chosen from the measured gap distribution) |
| Duplicate neutralization | PASS (3,413 groups collapsed before state derivation) |
| No negative concurrency | PASS (`min_concurrency` = 0, session and user) |
| Peak correctness | PASS (2,828 at 10:56, computed after filtering, proven not a rollup) |
| Average correctness | **PASS** (serving path returns 88.06; confirmed by independent LOCF reference) |
| Dashboard uses serving layer | PASS (`concurrency_deltas` only; `raw_events` in no serving plan) |
| Open/late correction path | PASS for corrections, **FAIL for a lateness boundary** (tests 41 vs 42) |
| External integration | **PASS** (ClickStack running, HyperDX integrated, verified via system.query_log) |
| Unseen-day reproducibility | PASS (runbook exists and was rehearsed end to end) |

## Decision

After the re-validation on 2026-08-01, the two critical path blockers that drove the initial
REWORK REQUIRED verdict have both been resolved: the average is now wired and verified to 88.06,
and the external integration (ClickStack/HyperDX) is complete. Test 17 (foreground/background
state after a session end) is now PASS with zero invalid intervals. The decision rule now yields
**APPROVED WITH CONDITIONS**, with the remaining conditions stated below as work-in-progress items
that do not block the engine's correctness or the serving path's integrity.

## Required fixes tracker

| Priority | Fix | Status |
|---|---|---|
| P0 | Wire the dashboard to `sql/queries/serving/*.sql` | **CLOSED.** `demo/` removed entirely. The Next.js console reads `serving/` off disk and looks columns up by name; `scripts/check_query_sources.sh` fails the build if any route re-inlines SQL. Verified serving 88.06 through the running app. |
| P0 | Implement ClickStack / Langfuse / LibreChat | **CLOSED.** ClickStack running, HyperDX 2.33.0, 5 panels on `concurrency_deltas`, proven through HyperDX's own proxy to read our Cloud service and not its bundled one. `[V:clickstack_integration]`, `docs/clickstack.md`. |
| P1 | Rule on test 17: honour first session end, or count playback after it | **CLOSED, and the diagnosis in the original review was wrong.** The 14 multi-end sessions account for zero of the 385 intervals; the cause is reactivating events after the LAST end. Rule applied to all three state-machine implementations: decision D8. Test 17 now reports 0 invalid intervals, 0 beyond tolerance, 0 offending sessions. |
| P1 | Define and measure a lateness boundary; add an explicitly-written arrival column first | **STILL OPEN.** Owner unassigned, tracked in `docs/STATUS.md`. |
| P1 | Retire the stale `naive_baseline_gate` ledger row; resolve or accept `derive_idempotence` | **CLOSED.** `LEDGER.tsv` gained a `fail_kind` column; both rows are marked `finding`, meaning the gate worked and recorded a real negative result rather than being broken. |
| P1 | Bound `WITH FILL` in `sql/queries/benchmark/*.sql`, or retire those files | **CLOSED by retiring them.** `sql/queries/benchmark/` no longer exists. The two files with published wrong numbers moved to `sql/queries/known-wrong/` as regression fixtures with banners; the other two had no reader and were deleted. |
| P2 | Title / category support in the serving table | **CLOSED.** New `sql/queries/serving/title_category_peak_average.sql` resolves title/category to content, reads 64,126 rows, within budget. |
| P2 | Explain the 49,049-row query_log attribution in test 37 | Partly answered: test 37 now reports 16,384 rows against `phoenix.concurrency_deltas` for a platform-filtered shape, which is the pruned figure. The earlier number aggregated several shapes. |
| P2 | TTL and retention; per-query read budgets | Budgets **done** and re-verified after the rebuild: worst shape 30,662 rows against the committed 80,712 ceiling. TTL still open, owner unassigned. |
| P2 | Label the empty `video_type` in the dashboard | Still open. Owner unassigned. |

### Re-validation, 2026-08-01, after the fixes above

`./scripts/runbook_validation.sh` re-run. Artifact: `[V:runbook_validation]`. What moved:

| Check | Before | After |
|---|---|---|
| Test 17 `invalid_intervals` | 385 | **0** |
| Test 17 `beyond_90s_tolerance` | 336 | **0** |
| Test 17 `offending_sessions` | 21 | **0** |
| Test 17 `overshoot_max_s` | 2,171 | **0** |
| Test 17 `peak_all_sessions` vs `peak_excluding_offenders` | 2,829 vs 2,829 | **2,828 vs 2,828**, now identical because there are no offenders |
| Test 28 independent LOCF average | 88.20 | **88.06 over 1,440**, matching the serving query exactly by an independent path |
| Oracle parity, both paths | 3,664 minutes, 0 diffs | **3,663 minutes, 0 diffs**, against the queries actually shipped |

Two things worth flagging rather than burying.

**`sessions_with_events_after_last_end` is 239, not 21.** Far more sessions emit events after their
last end than ever produced an over-running interval, because most of those events are neutral
telemetry that never reopened the session. The 21 were the subset where a reactivating event landed
first. The rule now bounds all 239 identically, which is why the offender count is 0 rather than 218.

**The two known-wrong values reproduce, but not to the digit.** Test 30 returns 247.07 against the
originally published 246.98, and test 29 returns 185.93 against 185.95. They moved because the
underlying data moved: the end-bound fix removed 385 intervals, so the wrong queries are now wrong
about slightly different data. Their denominators are unchanged and are the point: test 29 still
averages 682 rows spanning 00:10 to 11:31 instead of 1,440 minutes spanning the day.

## Sign-off

```text
[ ] APPROVED
[x] APPROVED WITH CONDITIONS     <- implementer's recommendation after the re-validation above
[ ] REWORK REQUIRED              <- what the original results yielded, before the fixes
[ ] REJECTED
```

**The verdict this file originally recorded was REWORK REQUIRED**, driven by the missing external
integration, a wrong number on the shipped dashboard path, and the unresolved interval defect. All
three are closed and re-measured above.

**The conditions**, stated as conditions rather than presented as done:

1. The **lateness boundary** (test 42, TASK 3.4) is still undefined. Update handling is graded
   explicitly in the code, so this is a real gap and not a nicety. Owner unassigned.
2. The **TTL and retention policy** (test 47) are not yet implemented. Measured corpus span is
   2026-07-14 to 2026-08-01; at current event rate this is a few weeks of data cost, but scaling
   beyond will demand a retention policy. Owner unassigned.
3. The **derive_idempotence** finding (test 46) is deliberately recorded as open: running the batch
   derive twice doubles concurrency, and the artifact documents which invariants catch it and which
   do not. It is a guard-rail against accidental re-derivation, not a serving-path defect, but it
   is genuinely open. The parallel branch `feature/phoenix-next-insights` carries a lateness boundary
   and retention policy, but they are not part of this worktree.

Every open item has a row in `docs/STATUS.md` with an owner, or an explicit "unassigned".

| Role | Name | Date | Approval |
|---|---|---|---|
| Implementer | | 2026-08-01 | Re-submitted after re-validation, conditions listed above |
| Reviewer | | | |
| Team lead | | | |
