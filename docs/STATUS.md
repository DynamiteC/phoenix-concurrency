# Status

**2026-08-01.** The file to open first. What is done, what is in flight, what has not started,
and who owns each.

Every "done" below has a command that reproduces it and an artifact in
[`evidence/LEDGER.tsv`](../evidence/LEDGER.tsv). If a row says done and you cannot find its
artifact, treat the row as wrong and say so.

## One-paragraph summary

The pipeline works end to end and is validated against an independent brute-force oracle at zero
diffs, on both derivation paths, against the queries actually shipped. The ClickStack integration
is **built and running**, with HyperDX proven to read our Cloud service rather than its own bundled
one. Headline numbers for 2026-07-26: peak **2,828** concurrent sessions at 10:56, average **88.06**
over all 1,440 minutes, **200.00** over the 634 minutes with an audience. The serving layer answers
curve, peak, both averages, p95 and reach with dimension filters at any grain, worst shape reading
**30,662 rows in 12 ms**. Full rebuild is shadow-and-swap and is proven idempotent by running it
twice and diffing every derived table row by row.

**Read this if you read nothing else:** the numbers above are one restatement newer than most of
this repo's prose. The end-bound fix (decision D8) moved peak from 2,829 to 2,828 and the average
from 88.20 to 88.06. `corrections.md` lists every restated figure. Older documents still carry the
previous values and are kept deliberately as the audit trail.

## Done

| Item | Evidence | Owner |
|---|---|---|
| Raw and content ingestion, 905,558 + 33,464 rows | `inventory_phoenix` | done |
| Foreground state machine, validated vs oracle at 0 diffs | `oracle_parity` | done |
| Session-aware and session-independent (user) rollups | `frozen_slice_stability` | done |
| Incremental absorption of open sessions, 0 diffs vs batch truth | `open_sessions` | done |
| Ground state, contamination blast radius, isolation predicate | `frozen_slice_stability`, `ingest_probe` | done |
| Serving query set: curve, peak, both averages, any grain | `filter_shapes` | done |
| Filter-shape read table, 8 shapes, cold and warm | `filter_shapes` | done |
| Read budgets committed as `SETTINGS` at 3x measured | `filter_shapes` | done |
| Peak-is-not-a-rollup regression test, 4 of 4 | `peak_not_a_rollup` | done |
| Naive baseline, 32.3 percent overcount, gate passing | `naive_baseline` | done |
| Unknown-vocabulary report | `unknown_vocabulary` | done |
| Lazy materialization tested and written up both ways | `lazy_materialization` | done |
| Unseen-day runbook, rehearsed at 70 seconds | `runbook_rehearsal` | done |
| Verification ledger, written from inside `evidence()` | `evidence/LEDGER.tsv` | done |
| Oracle parity re-run against the rewritten serving layer, 4 of 4 at 0 diffs | `oracle_parity` | done |
| Schema audited against the 31 ClickHouse best-practice rules | `clickhouse_rules_audit` | done |
| Guarded derive: a double derive is refused, not merely detected | `derive_idempotence` | done |
| **ClickStack integration**, HyperDX on our Cloud service, 5 live panels | `clickstack_integration` | done |
| Frozen-slice gate at full PASS, 2,528 rows ingested between runs, 0 differing lines | `frozen_slice_stability` | done |
| **No interval extends past its session's last end**, 385 removed | `rebuild_swap_phoenix_next` | done |
| Shadow-and-swap rebuild, with a one-command rollback | `rebuild_swap_phoenix_next` | done |
| **Rebuild idempotence proven by running twice and diffing**, 0 diff lines on all 5 tables | `rebuild_idempotence` | done |
| One source of truth for shipped query text, machine-checked | `oracle_parity` | done |
| Sparse-series sweep: every instance found, fixed or labelled | `runbook_validation` | done |
| Decisions register, backfilled | [`DECISIONS.md`](DECISIONS.md) | done |

## In flight

| Item | State | Blocker | Owner |
|---|---|---|---|
| Read budgets after the rebuild | Re-measured, still valid: worst shape 30,662 rows against the committed 80,712 ceiling, 490,592 bytes against 1,291,392. No change needed. One bench shape (`country`) returned `NA` because its `query_log` lookup did not resolve; the other seven are complete. | Re-run `./scripts/bench.sh` to fill that one cell | unassigned |

## Not started, or deliberately deferred

Each of these is a real gap. None is hidden behind a green checkmark.

| Item | Why it matters | State | Owner |
|---|---|---|---|
| Lateness boundary (TASK 3.4) | Update handling is graded explicitly. An undefined boundary is an undefined answer to a graded question. | **Not done.** The pipeline absorbs late events correctly via retract-and-reassert, proven in `[V:open_sessions]`, but there is no defined limit on how late is too late, and nothing is emitted when one is crossed. | **unassigned, needs naming** |
| Seeding test re-run with differing upper bounds (TASK 3.3) | The prior pass was a tautology: both windows shared the same upper bound, so identical reads proved nothing. | **Not done.** The property to demonstrate is that read volume scales with the position of the range END, never with the width of the window. | **unassigned** |
| `title` and `category` dimensions from the content dataset (TASK 3.5) | Two filterable dimensions the data supports and the serving layer does not carry. | Not done. Additive: a column on `content`, then on the delta key. | **unassigned** |
| TTL policy on the detail and delta tables (TASK 3.5) | Unbounded growth. Not urgent at 30K delta rows; a real question at 100x. | Not done. | **unassigned** |
| Key order at realistic volume (TASK 4.1) | At 4 granules every candidate key prunes identically, so the experiment is uninformative rather than negative. The 36 percent disk difference IS informative and is reported as such. | Not done. Cheap unlock: synthesise 100x **delta** rows by fanning dimension tuples over the existing minute series. No re-derive, no ingest. | **unassigned** |
| OTLP spans on 4317/4318 (TASK 2.1 layer 3) | Layer 3 of the integration. | **Deviated deliberately.** `system.query_log` already holds `read_rows`, `read_bytes` and `elapsed_ms` on the same service, and panel 5 reads them there, so emitting spans would duplicate data that is already queryable. Stated as a deviation, not a completion. | unassigned |
| Frozen predicate on `sql/queries/validation/data_quality.sql` | The file instructs "run after every load, including the unseen day", but carries no `frozen_before`, so every count drifts with live ingest and is not comparable between runs. | **Not done.** Found during the carry-forward sweep. Roughly 18 subqueries need the bound. | **unassigned** |
| Rendered appearance of the ClickStack tiles | The data path is proven through HyperDX's own proxy; the pixels are not. | HyperDX's UI sits behind a login form and no password was typed into it. Open `http://localhost:8090` with the credentials in [`clickstack.md`](clickstack.md) to confirm visually. | anyone with 2 minutes |

## Known limits, stated rather than discovered

- **Dimension attribution is first-seen per session.** 95 of 10,866 sessions report more than
  one platform and 120 report more than one `user_id`. Each session is filed under the
  dimensions of its first event.
- **`country` prunes nothing** because it has exactly one value (`india`) in this corpus. Not
  a key-order problem, a cardinality fact. `problem/DESIGN.md` section 7.
- **Only `platform` prunes** among single-dimension filters, because it leads the ORDER BY.
  Content-only reads the whole delta table. Measured, with the decision and its trigger in
  `problem/DESIGN.md` section 7.
- **The cumulative sum reads the whole series** for the filter tuple and cannot be pruned by a
  time predicate. 26,904 rows today. At 100x this is what needs day-boundary snapshots.
- **A backgrounded client that keeps emitting heartbeats is counted** until the 90-second gap
  cap. The tolerance is what makes a missing `AppBackgrounded` safe, and it is the same
  mechanism that makes this case unsafe.
- **`foreground_intervals` is batch-only.** The incremental path writes `session_minute_runs`
  directly, so in an incrementally-built database that table is empty by design.
- **A session with no `VideoSessionEnd` is unbounded.** Decision D8 caps intervals at the session's
  last end; a session that never ends is capped only by the 90-second gap tolerance. All 10,866
  sessions in this corpus carry an end, so that path is untested rather than known-good.
- **`concurrency_deltas` receives live rows.** It is not a static table. Every graded query carries
  `frozen_before` for that reason, and the ClickStack panels deliberately do not. See D10.
- **The five-table `EXCHANGE` is not one atomic operation.** ClickHouse has no multi-table exchange,
  so there is a millisecond window mid-swap where some tables are new and some old. Each table is
  individually consistent throughout, which is strictly better than truncate-and-reinsert, where
  the window is the whole derive.

## Ingest, which is not ours

Owned by a teammate and untouched by this work. Two findings filed, neither fixed:

- [`issues/ingest-1.md`](issues/ingest-1.md): the stream stamps wall-clock arrival time into
  `event_timestamp`. Benign here because the live rows are disjoint from the corpus in both
  time and session id, which is what makes the isolation predicate a clean cut.
- [`issues/ingest-2.md`](issues/ingest-2.md): the stream is started and stopped by hand. It ran
  again during this session, which is what finally let the frozen gate reach a full `PASS` with
  2,528 rows arriving between its two snapshots `[V:frozen_slice_stability]`, and it had stopped
  again by the end of it. Originally filed when the stream stopped at 13:20:52. It runs as a
  scripted replay loop at 26 to 27 inserts per minute. **No freshness SLA may be quoted off
  it**, because end-to-end freshness is bounded by when somebody starts the loop.
- [`issues/ingest-3.md`](issues/ingest-3.md): insert batches average **66 rows** against a
  10,000 guideline. Harmless today, merge pressure at 100x. Two remedies offered, the
  owner's call.

## Where to look

| Question | File |
|---|---|
| What is actually on the server | [`GROUND_STATE.md`](GROUND_STATE.md) |
| What each table is for and why | [`DATA_MODEL.md`](DATA_MODEL.md) |
| Physical reference: engines, columns, keys, sizes | [`database_details.md`](database_details.md) |
| Why each design choice, and what it cost | [`problem/DESIGN.md`](problem/DESIGN.md) |
| What we got wrong and how we caught it | [`corrections.md`](corrections.md) |
| What to run when the sealed data drops | [`RUNBOOK_UNSEEN_DAY.md`](RUNBOOK_UNSEEN_DAY.md) |
| Claim to command, in one hop | [`../evidence/LEDGER.tsv`](../evidence/LEDGER.tsv) |
| Why this and not that, with the cost of each option | [`DECISIONS.md`](DECISIONS.md) |
| How the ClickStack integration is built and rebuilt | [`clickstack.md`](clickstack.md) |

`docs/ROADMAP.md` and `docs/assumptions.md` predate this session and carry numbers that have
since been corrected. `corrections.md` lists every one. Prefer the files above; the older two
are kept because deleting them would delete the audit trail.
