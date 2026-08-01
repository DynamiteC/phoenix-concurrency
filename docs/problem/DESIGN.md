# Design decisions, with their trade-offs and their measured cost

**As of 2026-08-01.** Every number here was produced by a command run against the live
service. `[V:<id>]` resolves to a row in [`evidence/LEDGER.tsv`](../../evidence/LEDGER.tsv)
naming that command and its artifact. `[A]` marks an assumption, with what would falsify it
and who decides. `./scripts/check_docs.sh` enforces both.

The measurements below are taken on the frozen slice, `event_timestamp < 2026-08-01`, which
is the validated corpus: 905,558 events, 10,866 sessions, 9,618 users, spanning
2026-07-14 15:43 to 2026-07-26 11:30. `[V:frozen_slice_stability]`

---

## 1. Active intervals, not sessions

**Decision.** Concurrency counts foreground playback intervals derived from a per-session
state machine, never the span from session start to session end.

**Cost of getting this wrong, measured.** `[V:naive_baseline]` A naive baseline table built
with the identical minute-boundary rule, differing only in that it counts each session from
first event to last:

| | Naive span counting | Foreground-only | Difference |
|---|---:|---:|---|
| Peak concurrent sessions | 3,742 | **2,829** | **32.3 percent overcount** |
| Peak minute | 2026-07-26 10:59 | 2026-07-26 10:56 | 3 minutes apart |
| Minutes with an audience | 5,254 | 3,664 | **1,592 phantom minutes** |

The peaks land on different minutes, so this is not a constant scale factor that a reader
could mentally correct for. 1,592 minutes have a naive audience and no real one.

**The comparison is honest about its own edges.** The two tables span ranges differing by one
minute, because a foreground interval runs to `last_event + tolerance` and can reach into a
minute the session's last raw event did not. The comparison is clipped to the overlap and the
excluded minute is reported in the artifact rather than hidden. `[V:naive_baseline]`
`inverted_minutes = 2`: two minutes have a real audience and no naive one, for the same
tolerance-tail reason. Reported because a one-directional error table would be suspicious.

**Trade-off accepted.** The state machine is more code and more derivation cost than
`max(ts) - min(ts)` per session. The problem statement names overcounting backgrounded time
as "the failure mode this whole problem exists to prevent", so 32.3 percent is not a price
worth paying for simplicity.

## 2. The classifier defaults unknown vocabulary to inactive

**Decision.** Events that open playback are enumerated. Everything else is neutral: it
carries the previous state forward and can never, on its own, start counting someone as
watching.

**Why this is the conservative direction.** An unknown value that defaults to active
manufactures viewing time. An unknown value that defaults to neutral can at worst fail to
extend it. Given the grading criterion, those two errors are not symmetric.

**This is not hypothetical, and it has already been exercised.** `[V:frozen_slice_stability]`
The frozen corpus contains 7 distinct `event_type` values and **47** distinct `event` values.
`[V:ingest_probe]` The live stream introduced two `event` values that appear nowhere in the
corpus, taking the whole-table count to 49. Both were absorbed correctly with no code change:
one arrives under `event_type = 'VideoPlay'` and is classified by its type, the other under
`VideoHeartbeat` with an unrecognised `event` value and is therefore neutral.

`[A]` The data dictionary calls its list "current event types", which is an admission that it
is not exhaustive, and the live stream has now proved it. **Falsified by:** a value appearing
that the classifier maps to active without a human deciding it should. **Decided by:** the
team, before the unseen day.

## 3. Deltas from merged minute runs, not from intervals

**Decision.** Intervals are merged into per-session minute runs first, and `+1` / `-1` deltas
are emitted from the runs. Emitting a delta pair per interval double-counts a session that
has several intervals inside one minute.

**Measured cost.** `[V:frozen_slice_stability]` 905,558 events collapse to 599,137 intervals,
then to 17,604 asserted runs, then to a delta table covering 1,532 distinct minutes and
**61 KiB on disk**. The serving layer is roughly 1/4000th of the 232 MB source CSV.

**The invariant that proves it worked.** `[V:frozen_slice_stability]`
`max_runs_per_session_minute = 1`. No session-minute is covered by two asserted runs, so no
session can contribute more than 1 to concurrency at a single instant. This is the single
most damaging way the pipeline could be silently wrong, so it is checked on every run rather
than argued about.

## 4. Peak and average are computed at query time, never stored per rollup

**Decision.** Peak and average are derived from the per-minute series for the exact filter
tuple requested. No peak is precomputed at any rollup level.

**Why, measured.** `[V:peak_not_a_rollup]` Four assertions, all passing:

| Assertion | Observed |
|---|---|
| Unfiltered peak minute differs from `video_type = live` | 10:56 vs **10:45** |
| Unfiltered peak minute differs from a platform slice | 10:56 vs **11:02** |
| Overall peak exceeds the max of per-platform peaks | 2,829 vs **1,743** |
| Overall peak differs from the sum of per-platform peaks | 2,829 vs **2,918** |

The third and fourth together rule out both plausible shortcuts. Peak is not the largest part
(sessions on different platforms are concurrent with each other) and it is not the sum of the
parts (platforms do not peak in the same minute). It can only be computed from the filtered
series. `./scripts/test_peak.sh` fails the build if that ever stops being true.

## 5. The cumulative sum is seeded by every delta before the window

**Decision.** The running sum starts at the beginning of the series for the filter tuple, not
at the start of the requested range. A session that opened at 09:00 and is still watching at
10:30 emits no delta inside a 10:00-11:00 window and would otherwise be lost.

**The audit asked for, and its actual result.** The existing benchmark queries were audited
for this bug. **It is not present**, and that is a measurement rather than a reading of the
SQL: `[V:filter_shapes]` a one-hour window and a whole-corpus window read exactly the same
number of rows, so the analyzer is not pushing the `minute >= from_ts` predicate down through
the window function into the scan. Had it been pushed, the narrow window would have read
less and returned a curve starting at zero.

**A second seeding trap, which WAS present in the new code and is now fixed.** `WITH FILL`
alone does not seed the window. It carries a value forward from the previous row *in the
result set*, so a window opening at 10:30 whose first delta lands at 10:31 has nothing to
carry from and renders 0. Measured: it reported 1 where the true concurrency at 10:30 was
**327**. The serving queries now emit an explicit row at `from_ts` carrying the concurrency as
of that minute.

**No checkpoint table was built.** `TASK.md` asks that the seed scan's cost be measured
before a per-dimension-tuple baseline table is considered. It reads 26,904 rows in 10 ms
`[V:filter_shapes]`. A checkpoint table keyed by dimension tuple explodes combinatorially
(10 platforms x 3 video types x 3,357 contents x 65 app versions) and would cost more than
the scan it replaces. Revisit only if the seed scan is measured to be the bottleneck.

## 6. The average denominator, and why both ship

**Decision.** `avg_all_minutes` is primary: the mean over every minute in the range,
including minutes with zero audience. `avg_active_minutes` ships alongside it.

**They differ materially.** `[V:filter_shapes]` Over 2026-07-26, unfiltered: **88.20** against
**200.00**, across 1,440 minutes of which 635 had an audience. The choice is not cosmetic.

**Why both.** The ground truth is private. All-minutes-including-zeros is the defensible
reading of "average concurrency over a range", but a definition mismatch we cannot see is
cheap to insure against and expensive to discover after submission.

**This section exists because both shipped queries were wrong.** Measured over the same day:

| Query | Reported | Denominator | Error |
|---|---:|---|---|
| `benchmark/peak_average.sql` | 246.98 | sparse delta-boundary minutes only | **2.8x over** |
| `benchmark/concurrency.sql` | 185.95 | 683 minutes (`WITH FILL`, no `FROM`/`TO`) | **2.1x over** |
| `serving/peak_average.sql` | **88.20** | 1,440 minutes | correct |

Peak was 2,829 in all three. That is exactly why this survived: concurrency only changes at a
delta boundary, so the maximum over boundaries **is** the maximum over minutes and peak is
immune. Averages and minute-counts are not. Any metric computed by counting curve rows is
counting boundaries, not minutes.

## 7. Filter-friendliness, measured rather than asserted

`concurrency_deltas` is ordered `(platform, country, video_type, content_id, app_version,
minute)`. The judging criterion is explicit that "judges will look at what your queries read",
so this is the measurement, not the argument.

`[V:filter_shapes]` Per filter shape, one full day, `serving/peak_average.sql`, on the frozen
slice. Cold and warm are separate columns; `use_query_cache` is **0** on this service so warm
reflects page cache only and no number here comes from a query cache.

| Filter shape | Cold ms | Warm ms | Rows read | Bytes read | Marks | Parts | Granules |
|---|---:|---:|---:|---:|---:|---:|---|
| unfiltered | 10 | 11 | 26,904 | 215,232 | 4 | 1 | 4/4 |
| platform | 11 | 11 | **16,384** | 147,533 | **2** | 1 | **2/4** |
| country | 11 | 11 | 26,904 | 242,197 | 4 | 1 | 4/4 |
| content | 15 | 11 | 26,904 | 430,464 | 4 | 1 | 4/4 |
| video_type | 11 | 11 | 26,904 | 242,167 | 4 | 1 | 4/4 |
| app_version | 12 | 12 | 26,904 | 243,062 | 4 | 1 | 4/4 |
| platform + country | 12 | 12 | **16,384** | 163,938 | **2** | 1 | **2/4** |
| content + platform | 12 | 11 | **16,384** | 278,605 | **2** | 1 | **2/4** |

**The honest reading.** Only shapes containing `platform`, the leading key column, prune.
Everything else reads the whole table. `content` sits fourth in the key, so a content-only
filter cannot use the key prefix, exactly as predicted, and the measurement confirms it at
4/4 granules rather than contradicting it.

Two things not to overclaim:

- **`country` prunes nothing, and cannot.** It has exactly one distinct value in this corpus
  (`india`). Even in second key position, a filter on a single-valued column excludes no
  granule. Reporting its 4/4 as a key-order problem would be wrong; it is a cardinality fact.
- **`force_primary_key = 1` passes for every shape, including content-only.** That is because
  `minute` is itself the last column of the ORDER BY and the range predicate always engages
  it. It proves the key is used at all. It does **not** prove the dimension filter pruned.
  The granule column above is what shows that, and it shows it only for `platform`.

**No second table and no projection was added.** `TASK.md` says to add one only if content-only
"measures badly". It reads 26,904 rows in 11-15 ms, which is not badly at this scale. The
case for acting is the 100x argument, not today's latency, so it is recorded as a decision
with a trigger rather than built speculatively.

`[A]` **Recommendation, not a finding, and it is the team's call.** If content-only filtering
becomes a primary access pattern, prefer a second MV-maintained deltas table with a
content-leading ORDER BY over a PROJECTION. A projection on SummingMergeTree needs
`optimize_use_projections` (confirmed present and enabled on 26.2.1.525
`[V:inventory_phoenix]`), and there is a known interaction where lazy materialization plus
projections raises `AMBIGUOUS_COLUMN_NAME`. A second table has no such surprise and its cost
is legible: roughly another 61 KiB and one more MV firing per insert. **Falsified by:**
content-only latency measured as a bottleneck on the unseen day. **Decided by:** the team.
**Do not reorder the existing key**, which would trade platform pruning for content pruning
rather than gaining anything.

## 8. Read budgets as committed assertions

**Decision.** Both serving queries carry `SETTINGS max_rows_to_read = 80712,
max_bytes_to_read = 1291392, force_primary_key = 1`.

`[V:filter_shapes]` The ceilings are **3x** the worst measured shape (26,904 rows /
430,464 bytes). A breach raises `TOO_MANY_ROWS` and the query fails, so "what your queries
read" is machine-checked rather than asserted in a document that can drift.

**Why 3x rather than the exact figure.** The cumulative sum must be seeded by the whole series
for the filter tuple, so the read grows with the corpus rather than with the requested window.
An exact budget would breach on the first additional day of data, turning a real signal into
noise at the moment it matters most. 3x absorbs several days while still catching a full-table
regression. Recalibrate with `./scripts/bench.sh`; do not raise it by reflex.

## 9. Isolation from the live stream

**Decision.** `event_timestamp < {frozen_before}`, one parameter injected by `scripts/ch.sh`
from `$FROZEN_BEFORE`. Not `ingested_at`.

`[V:ingested_at_nondeterminism]` `ingested_at` was added by an `ALTER` after the corpus was
loaded. ClickHouse does not rewrite existing parts, so for those rows `DEFAULT now()` is
evaluated at **read** time and the column equals the reading query's own wall clock. A
watermark filter on it retained **0 of 905,558** corpus rows and **all** live rows: precisely
backwards.

`[V:ingest_probe]` `event_timestamp` is a stored value and the two slices are disjoint in it:
`sessions_spanning_the_boundary = 0` and `runs_straddling_boundary = 0`. That is what makes
the predicate a clean cut rather than an approximation, and it is why no rebuild of `phoenix`
was needed despite 55,293 live rows having propagated into every derived table.

## 10. Behaviour at 100x

`[A]` The parts of this that are measured are labelled; the rest is reasoning from the
measured shape and is marked as such. **Decided by:** the team, if the design is taken further.

**What scales without change.** The serving layer is a function of interval boundaries, not of
watch time. `[V:frozen_slice_stability]` 905,558 events produce 1,532 distinct delta minutes
and 61 KiB. A session watching for three hours costs the same two delta rows as one watching
for two minutes. At 100x events the delta table grows with concurrent-session boundaries, not
linearly with the event count.

**What breaks first, and it is named rather than glossed.** The cumulative sum reads the whole
series for the filter tuple, because a prefix sum cannot be pruned by a time predicate. Today
that is 26,904 rows in 10 ms `[V:filter_shapes]`. At 100x it is a few million rows per query,
which is still tractable but no longer trivial. The fix, when it is needed, is snapshot rows
at day boundaries so the sum can start from the most recent snapshot rather than from the
beginning of time. It is deliberately **not** built now: `TASK.md` asks for the seed scan to
be measured first, and at this scale it does not justify a per-dimension-tuple baseline table
that would explode combinatorially.

**What is already bounded.** Abandoned sessions cannot accumulate unbounded state: every open
interval is capped at `last_event + tolerance`, so a session that stops emitting stops being
counted 90 seconds later whether or not it ever sends a close event.

## 11. Lazy materialization: tested, and it does not help the benchmark set

`[V:inventory_phoenix]` Both settings exist on 26.2.1.525:
`query_plan_optimize_lazy_materialization` is enabled by default and
`query_plan_max_limit_for_lazy_materialization` is 10000.

**On the benchmark queries it does nothing, as predicted.** `[V:lazy_materialization]`
`EXPLAIN actions = 1` over `SELECT minute, sum(delta) FROM concurrency_deltas GROUP BY minute`
contains **no `LazilyRead` operator**. That is the expected and correct outcome: lazy
materialization defers reading columns until after a `LIMIT` has cut the row set, and an
aggregation has no `LIMIT` and reads every column it needs anyway. Nothing here is switched
on to look tuned.

**Where it does engage, it is a real win, and it is worth knowing about.**
`[V:lazy_materialization]` On an interval-detail query returning nine wide columns with
`ORDER BY ... LIMIT 8`, the plan does contain `LazilyReadFromMergeTree`, deferring seven
columns:

| | Rows read | Bytes read | ms |
|---|---:|---:|---:|
| `query_plan_optimize_lazy_materialization = 0` | 599,137 | 92,301,846 | 26 |
| `query_plan_optimize_lazy_materialization = 1` | 656,481 | **17,961,584** | **15** |

It reads **more rows** and **5.1x fewer bytes**. The extra rows are the second pass; the byte
saving is the seven deferred columns being fetched only for the eight rows that survive the
`LIMIT`. Since bytes off disk is what costs, it is 1.7x faster.

**Conclusion.** Left at its default. It is irrelevant to every query in the benchmark set,
and beneficial to session-detail and top-N drill-down queries, which is where a dashboard
would use it. Recorded in both directions so that neither the negative nor the positive has
to be rediscovered.
