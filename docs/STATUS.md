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
| **`phoenix_next`, the generation-2 replica**, re-derived independently, 21,600 minutes at 0 diffs | `replicate_phoenix_to_phoenix_next`, `replica_parity_phoenix_next` | done |
| **Schema drift detector**, and the index it found live that no file in the repo created | `schema_drift_phoenix`, `schema_drift_phoenix_next` | done |
| Trustworthy `arrival_timestamp`, materialised by the MV, sentinel on copied rows | `replicate_phoenix_to_phoenix_next` | done |
| **`audience_minute_snapshot`**, 3,663 minutes matching the authoritative session AND user curves at 0 diffs | `insight_parity_audience_snapshot` | done |
| **`content_entry_cohorts`**, 8,530 cohorts at 0 diffs, retention measured at an instant not as not-yet-ended | `insight_parity_cohorts` | done |
| **`playback_health_minute`**, 296 minute-tuples at 0 diffs, denominator documented | `insight_parity_health` | done |
| Four insight benchmark queries, `raw_events` absent from every plan, budgets set from measurement | `insight_bench_*` | done |
| **`session_insight_facts`**, the keystone, 10,866 sessions and 31 columns at 0 diffs vs an independent ground truth | `insight_parity_session_facts` | done |
| Insight read cost: 6 shapes, `raw_events` absent from every plan, budget set from measurement | `insight_bench_session_facts_app_version_health` | done |
| Insight refresh idempotence: 238,983 stored versions collapse to 119,491 rows under FINAL | `refresh_insights_phoenix_next` | done |
| Lateness policy enforced and classified, 8 of 8, boundary marked provisional | `lateness_classifier` | done |
| Session-end rule ruled on with a measurement (D13) | `end_rule_first_vs_last` | done |

### `phoenix_next`, and what replicating proved

`phoenix` is generation 1 and is never written to by this workstream. `phoenix_next` is generation 2:
`scripts/replicate.sh` copies `raw_events` and `content` at a pinned cut and then runs the
**unmodified** pipeline, so its serving layer is an independent derivation rather than a copy. That
distinction is the whole point. `scripts/replica_parity.sh` compares the two on the frozen slice and
gets 0 differing rows, 0 missing keys and 0 unexpected keys across 21,600 minutes, with peak 2,828,
17,585 asserted session runs and all three averages identical on both sides. The pipeline is
reproducible, and the replica is a trustworthy base for the insight layer.

Replicating also surfaced what a paper review had missed. `phoenix.session_minute_runs` carried
`INDEX idx_run_range (run_start, run_end) TYPE minmax GRANULARITY 4`, created out of band and
present in no file in this repo. `rebuild_swap.sh` builds its shadow from `sql/schema/` and then
`EXCHANGE`s the tables into `phoenix`, so **the next rebuild would have deleted that index from
production**, and closure, overshoot and row counts would all still have passed. The index is now
declared in `sql/schema/04_concurrency.sql`, and `scripts/schema_drift.sh` runs inside
`check_docs.sh` against both databases so the next out-of-band change fails a check instead of
waiting to be noticed. It also falsified a sentence in `database_details.md` that said `phoenix`
held exactly the 12 objects `sql/schema/` defines.

Two related renames: the rebuild shadow moved from `phoenix_next` to `phoenix_rebuild`, because
`rebuild_swap.sh` drops its shadow twice per run and would have wiped the new database (D9
amendment). `scripts/lib/evidence.sh` no longer hardcodes `CH_DATABASE=phoenix` in the data stamp,
and `scripts/parity.sh` no longer seeds its scratch database from a literal `phoenix.raw_events`,
which would have compared a replica's serving layer against phoenix's raw data and gone green.

## In flight

| Item | State | Blocker | Owner |
|---|---|---|---|
| **Four undeclared changes landed in `phoenix` during one session** | `scripts/schema_drift.sh` caught each within minutes of existing. In order: `idx_run_range` on `session_minute_runs` (16:57, now declared in `sql/schema/`); `concurrency_boundary_deltas` plus its MV (18:02, hand-made, in no guard list, see the row below); `concurrency_deltas_naive` (18:10, recreated by the committed `scripts/naive_baseline.sh`, merely undeclared); and `event_id` ALTERed onto `raw_events`, `raw_events_landing` and `raw_events_mv` (18:20). `event_id` does **not** repeat the `ingested_at` defect, having no DEFAULT expression, but all 3,198,714 rows read `''` including rows ingested after the ALTER, so it is a column ahead of its producer. All four are allowlisted with reasons in `check_docs.sh` so the gate is not red for everyone. | Each needs its author to say whether it stays, and if so a file in `sql/schema/`. `phoenix_next` is unaffected: it is built from the repo DDL and checks clean with no allowlist. | **unassigned** |
| **`phoenix.concurrency_boundary_deltas` is undeclared production DDL, and a re-derive will double it** | Appeared in `phoenix` at 18:02 UTC on 2026-08-01, out of band, in no file in this repo: a `SummingMergeTree` at 79,371 rows plus a materialized view over `foreground_intervals`. Found by `scripts/schema_drift.sh` within minutes of that check existing. It is **absent from both guard lists**, `derive.sh:44` and `rebuild_swap.sh:33`, so `REBUILD=1 ./scripts/derive.sh` truncates the five tables it knows about, re-inserts into `foreground_intervals`, fires this MV a second time, and appends a whole duplicate set to a table nothing truncated. `sum(delta)` stays **0** throughout, because every duplicated `+1` brings its own `-1`. That is the exact doubling bug `derive.sh`'s own header documents, reintroduced in a table no guard covers. | Whoever created it: is it staying? If yes it needs a file in `sql/schema/` and a place in both guard lists. If no, drop it. | **unassigned, needs its author** |
| Read budgets after the rebuild | Re-measured: worst shape 30,662 rows against the committed 80,712 ceiling, 490,592 bytes against 1,291,392. Valid **today**, and see the countdown below, because this is a ceiling we are walking toward rather than a property we hold. One bench shape (`country`) returned `NA` because its `query_log` lookup did not resolve; the other seven are complete. | Re-run `./scripts/bench.sh` to fill that one cell | unassigned |

### The read budget is a countdown, not a pass

Stating this as a deadline rather than a checkmark, because the seeding test proved the mechanism.

No time predicate prunes granules `[V:seeding_position]`, so the curve query reads the **whole**
delta table on every request regardless of the window or of `frozen_before`. The budget is
therefore a function of table size alone.

- `concurrency_deltas` today: **30,662** rows. Ceiling: **80,712**. Headroom: **50,050 rows**.
- Observed growth during this session's active replay: roughly **8,500 rows per 45 minutes**.

At that rate the ceiling is reached after roughly **four hours of continuous ingest**, and the
failure mode is not a wrong number: the query raises `TOO_MANY_ROWS` and the dashboard returns 500.

Two honest readings, and the team should pick one rather than let it happen:

1. The ceiling assumes ingest is **not** left running indefinitely, which is true of the current
   operator-started replay loop but is not a property of the design.
2. If ingest becomes continuous, the fix is not a bigger number. It is day-boundary snapshots so the
   cumulative sum stops needing the whole prefix, which is the same change the 100x question needs.

**Owner: unassigned.** Raising the budget by reflex would convert a loud, early failure into a
silent, slow one, and the runbook already says not to.

## Not started, or deliberately deferred

Each of these is a real gap. None is hidden behind a green checkmark.

| Item | Why it matters | State | Owner |
|---|---|---|---|
| Lateness boundary (TASK 3.4) | Update handling is graded explicitly. An undefined boundary is an undefined answer to a graded question. | **Done, with two values marked provisional.** [`LATENESS.md`](LATENESS.md) defines the three settings and four classes; `sql/insights/schema/09_late_event_audit.sql` enforces them in the one place they are written; `[V:lateness_classifier]` puts one real event in each class through the landing table, 8 of 8. The boundaries are reasoned, not measured, because every row here was copied and a copied row has no observed arrival: 0 of 2,188,714. Stage 5 ingest sizes them from a real distribution and the query that will do it is committed. | done |
| ~~Seeding test re-run with differing upper bounds (TASK 3.3)~~ | Done, and it **falsified** the property it was written to confirm. See the row below. | **DONE** `[V:seeding_position]` | done |
| `title` and `category` dimensions from the content dataset (TASK 3.5) | Two filterable dimensions the data supports and the serving layer does not carry. | Not done. Additive: a column on `content`, then on the delta key. | **unassigned** |
| TTL policy on the detail and delta tables (TASK 3.5) | Unbounded growth. Not urgent at 30K delta rows; a real question at 100x. | **Documented and deliberately not switched on.** [`RETENTION.md`](RETENTION.md) gives per-table retention and the clause shape. It stays off until judging, replay and the unseen day's date range are settled, because a rule expressed in days from now deletes the frozen corpus once now moves far enough. The delta tables are excluded on purpose: the curve is a cumulative sum from the first minute, so truncating their head does not shorten the answer, it corrupts every later value. | done |
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
  time predicate. 30,662 rows today. At 100x this is what needs day-boundary snapshots.
  **Now measured rather than asserted, and the measurement falsified the nicer version of the
  claim** `[V:seeding_position]`. TASK 3.3 proposed demonstrating that read volume scales with the
  position of the range end and never with the width of the window. It does not: `read_rows` is
  **identical at 30,662 for all three** of a 1-hour window at the corpus start, a 1-hour window at
  the corpus end, and the whole 17,028-minute corpus. It scales with neither position nor width.
  Only `read_bytes` tracks the position of `to_ts`, at 155,416 early against 245,296 late, which is
  a decompression effect and not pruning. The cause is the deliberate key order: `minute` is last,
  so a time predicate cannot prune the prefix the cumulative sum needs, and therefore cannot prune
  granules either. The honest statement is that **read volume scales with the size of the corpus**,
  and only a dimension filter reduces it (platform prunes to 16,384 of 30,662). That is a real
  scaling limit rather than a pass, and it is what makes the 100x question a snapshot question.
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
