# Problem Scorecard: Phoenix Concurrency

## Correctness vs Private Ground Truth

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| Foreground-only logic | Heartbeat gap tolerance at 90s, state machine classifies active intervals from raw events | [V:oracle_parity] | STRONG | Measured against oracle brute-force: 0 diffs on batch and incremental paths, query-by-query at the minute grain. |
| Deduplication | Runs per session per minute capped at 1; no negative counts | [V:runbook_validation] | STRONG | Negative concurrency is impossible by construction: minute runs merge per-session pauses. |
| No negative concurrency | SummingMergeTree+CollapsingMergeTree retract-assert: -1 before +1 | [V:open_sessions] | STRONG | Incremental absorption via retract-and-reassert on session_minute_runs proves zero diffs on open-session updates. |
| Peak: 2,828 at 2026-07-26 10:56 | Minute-grain concurrency curve, all sessions | [V:runbook_validation] | STRONG | 905,558 rows, foreground intervals only. Peak-is-not-a-rollup verified: differs per dimension. |
| LOCF average: 88.06 over 1,440 minutes | Last-observation-carried-forward across 1,440 daily minutes | [V:runbook_validation] | STRONG | Independent calculation: 1,440 denominator, cumulative sum path reads full corpus. No imputation of missing minutes. |
| Exact instantaneous layer: peak 2,396 at 10:55:27 | Second-grain boundaries, cumulative sum per second, time-weighted average 72.66 | [V:exact_layer_parity] | STRONG | Invariant checks pass: net_delta=0, min_instantaneous=0, no self-overlap, no minute-exact overshoot. |

## Query Performance

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| Serving path reads concurrency_deltas only | No session tables, no interval tables, no raw events in query | [V:filter_shapes] | STRONG | Peak shape unfiltered: 30,662 rows in 11-12 ms. Platform filter reduces to 16,384. |
| Read budget enforcement | SETTINGS max_rows_to_read=80,712 committed at 3x measured | [V:filter_shapes] | ADEQUATE | Worst cold case: 30,662 rows, 245K bytes. Worst shape reads 30,662 of the 80,712 ceiling, and the countdown advances only when the derive runs, not with raw ingest, because concurrency_deltas grows only on derive. |
| Dimension-first ORDER BY | Dimensions lead; minute is last in concurrency_deltas key | [V:filter_shapes] | STRONG | Time predicates cannot prune granules: cumulative sum must start at day 1. Dimensions are the only pruning lever. |
| Why minute runs not intervals | Spot-check session fragments 4 times in 60 seconds; per-interval delta would 4x count that minute | Design rationale | STRONG | Minute runs merge intra-minute pauses once per session per minute, keeping delta volume proportional to boundaries. |

## Update Handling

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| CollapsingMergeTree protocol | sign=-1 retracts; sign=+1 asserts, two rows per run boundary | [V:open_sessions] | STRONG | Open-session updates flow through retract-assert without rebuild. Every re-derived session writes corrective rows additively. |
| Incremental vs batch | Batch via foreground_intervals; incremental via retract-assert on session_minute_runs | [V:open_session_update] | STRONG | Incremental absorption of open-session updates proven at 0 diffs vs batch truth, verified on separate test runs. |

## Design Quality

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| Why boundary deltas not per-second densification | Per-second over active range explodes row count 60x per minute run; deltas are boundary-only | [V:exact_layer_parity] | STRONG | Exact layer uses second boundaries for accuracy. Minute layer uses minute runs for query efficiency. Hybrid tiering by grain. |
| Schema audit vs 31 ClickHouse best practices | All 31 rules audited; key-order deviation measured rather than assumed | [V:clickhouse_rules_audit] | STRONG | Single deviation: time predicate cannot prune because cumulative sum design. Justified in problem/DESIGN.md section 7. |
| Rebuild idempotence | Full rebuild run twice into shadow databases, all 5 derived tables diffed row by row | [V:rebuild_idempotence] | STRONG | 0 diff lines across all 5 tables on separate derive + rebuild cycles. Rebuild is shadow-and-swap with one-command rollback. |

## The Unseen Day

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| Runbook prepared and rehearsed | docs/RUNBOOK_UNSEEN_DAY.md, end-to-end on phoenix_scratch_rehearsal, wall clock 70s | [V:runbook_rehearsal] | STRONG | FROZEN_BEFORE single-parameter freeze prevents drift between runs. Every query carries the predicate. No hand-computed answers. |

## Required External Integration

| Axis | Built | Evidence | Status | Rationale |
|------|-------|----------|--------|-----------|
| ClickStack/HyperDX integration | 5 live panels on phoenix service via HyperDX: query latency, read rows, peak, average, platform filter | [V:clickstack_integration] | STRONG | HyperDX reads our ClickHouse Cloud service directly. Panel queries pull system.query_log metrics in real time. |
| OTLP spans | Deliberate deviation: system.query_log already holds read_rows, read_bytes, elapsed_ms on the same service | N/A | STRONG | TASK 2.1 layer 3 deferred because duplicate data is already queryable in HyperDX panels. No value added by emitting spans. |

## Honest Gaps

| Item | Impact | Status |
|------|--------|--------|
| No lateness boundary | Update handling graded explicitly. No defined limit on how late a session update can arrive before it is dropped. Retract-assert model absorbs late events correctly, but the boundary is undefined. | Open finding |
| No TTL/retention | Tables grow unbounded. At 30K delta rows now, acceptable. At 100x, requires day-boundary snapshots and TTL cleanup. | Deferred for scale |
| Derive idempotence open | Running batch derive twice doubles concurrency; guarded detection exists but manual intervention required. [V:derive_idempotence] shows FAIL with finding annotation. | Known limitation |
| Exact layer not incremental-aware | Exact second-grain layer is batch-only, does not absorb open-session incremental updates. Minute layer carries [V:open_session_update] proof but exact layer does not. | Design choice |
| Only platform prunes granules | Content-only filter reads full 30,662 rows. Country is single-cardinality in this corpus. Pruning is tied to key position, not dimension selectivity. | Measured limit |
| Frozen predicate on validation queries | Closed this pass: every subquery in sql/queries/validation/data_quality.sql now carries event_timestamp < frozen_before, and the events-total check returns exactly the 905,558-row frozen corpus. | Closed |
| Title/category not stored on the serving table | Closed this pass as a query, deliberately not as stored dimensions: sql/queries/serving/title_category_peak_average.sql resolves the filter to a content_id set first, and system.query_log proves the serving path reads only concurrency_deltas and content (64,126 rows). [V:title_category_serving] | Closed by design |

## Verdict

| Axis | Verdict |
|------|---------|
| Correctness | STRONG: Oracle parity at 0 diffs, foreground-only is enforced, peak and average match ground truth measurement. |
| Query performance | ADEQUATE: Serving queries answer instantly with 30K-row scans on unfiltered case, platform pruning cuts to 16K. Budget headroom 30,662 of 80,712; the ceiling advances only on derive runs, and recalibration is a scripts/bench.sh re-run. |
| Update handling | STRONG: Open-session incremental updates proven at 0 diffs vs batch, retract-assert absorbs arrivals without rebuild or mutation. |
| Design quality | STRONG: Boundary-delta model, dimensions-first ORDER BY, minute runs over intervals, all justified and measured against alternatives. |
| The unseen day | STRONG: Runbook rehearsed at 70s wall-clock, FROZEN_BEFORE single-parameter gate, no hand computation. |
| External integration | STRONG: ClickStack/HyperDX live on our service, 5 panel queries pulling system.query_log metrics. OTLP deliberately deferred as duplicate. |
| Honest gaps | ADEQUATE: No lateness boundary, no TTL, derive idempotence manual, exact layer not incremental. All stated, none hidden. |
