# Insight layer: correctness and read cost

**2026-08-01.** The judge-facing matrix. One row per insight, both gates, every number from an
artifact in [`evidence/LEDGER.tsv`](../evidence/LEDGER.tsv) rather than from this document.

All figures are `phoenix_next`, the generation-2 replica. `phoenix` is not written to.

## Gate A: correctness against an independent ground truth

| Insight | Ground truth | Rows compared | Columns | Differing | Missing | Unexpected | Status |
|---|---|---:|---:|---:|---:|---:|---|
| `session_insight_facts` | `clickhouse local` over the raw CSV, own state machine | 10,866 | 31 | 0 | 0 | 0 | PASS |
| `session_state_transitions` | | | | | | | not started |
| `audience_minute_snapshot` | | | | | | | not started |
| `playback_health_minute` | | | | | | | not started |
| `content_entry_cohorts` | | | | | | | not started |
| `concurrency_spike_events` | | | | | | | not started |

`[V:insight_parity_session_facts]`. Two engines and two implementations: the optimized side reads
`foreground_intervals`, where the tolerance cap, the pause ruling and the D8 end bound already
live; the ground truth re-derives all three from raw events in a separate engine. It does not read
the `event_state` view, on the same principle the concurrency oracle states: a specification that
imports the implementation cannot catch the implementation's bugs.

**The gate is known to fail when it should.** A gate that has only ever passed is not known to be a
gate, so one session out of 10,866 was given one extra second of `active_seconds` at a higher
version. The comparison reported `differing_rows 1` and `verdict FAIL`. A refresh superseded the
perturbed row and it returned to PASS.

That failing run is kept:
`evidence/insight_parity_session_facts__20260801T175457Z__bd04d14-dirty.tsv`. It is cited by
filename rather than by a `[V:]` tag on purpose. The ledger holds one row per claim id and that row
must point at the CURRENT artifact, so a judge following a tag lands on the passing run; the
negative test is a different claim about the gate itself, and hand-writing a ledger row for it would
break the rule that only `evidence()` writes the ledger.

The artifact also asserts `rows_actually_compared` against `keys_in_common` and requires both to be
non-zero, because zero diffs over zero rows is the shape of a green check that checked nothing, and
a join whose key column fails to line up produces exactly that.

## Gate B: what the queries read

| Query | Reads | Worst shape | Rows read | Bytes read | Cold / warm | `raw_events` in plan |
|---|---|---|---:|---:|---:|---|
| `session_facts_app_version_health` | `session_insight_facts` | content | 21,732 | 2,243,290 | 27 / 20 ms | **no** |

`[V:insight_bench_session_facts_app_version_health]`, six filter shapes, `use_query_cache = 0`.
Budget committed on the query as `SETTINGS max_rows_to_read = 65199, max_bytes_to_read = 6729870`,
which is 3x measured.

**Two things the table would otherwise be read as saying, and does not.**

*Dimension filters do not prune this query.* Every shape reads about 21.7k rows, and `content`
reads more bytes than unfiltered because it must read `content_id` to filter on it. The ORDER BY
leads with `content_id` while the selective predicate is a `session_start` range spanning every
content id, so the key has nothing to prune with. At 119,491 rows and 3 granules this is noise.
Reordering the key would move the cost onto content-filtered queries, and the plan's own Phase 14
says not to make a risky immutable-key migration for a theoretical benefit. Re-measured at ten
times volume in Stage 5.

*Read cost scales with stored versions, not only with data.* 21,732 rows is two versions of each of
10,866 sessions, because the refresh had run twice and no merge had collapsed them yet. An
incremental refresh touches only changed sessions; the full refresh measured here is the worst
case. The 3x multiplier absorbs version accumulation as much as data growth.

## 10x and 100x

Projected, and labelled projected. Stage 5 replaces the 10x column with measurements.

| | 1x, measured | 10x, projected | 100x, projected |
|---|---:|---:|---:|
| `raw_events` | 2,188,714 | ~21.9M | ~219M |
| Sessions in `session_insight_facts` | 119,491 | ~1.2M | ~12M |
| Worst-shape rows read, one day | 21,732 | ~217k | ~2.2M |
| Worst-shape bytes read, one day | 2.24 MiB | ~22 MiB | ~224 MiB |
| Committed row ceiling | 65,199 | **breached** | **breached** |

**The projection is linear, and that is the finding rather than a shortcut.** The query's read is
proportional to sessions started inside the window, so ten times the sessions is ten times the read
with no sublinear term to hope for. Consequences, in the order they arrive:

1. **The committed budget breaches at roughly 3x**, by construction: it is 3x measured. That is the
   budget working as a tripwire rather than failing. The response is to re-measure and re-commit,
   which `scripts/bench_insights.sh` does in one command, and never to raise it by reflex.
2. **At 10x the key order stops being noise.** 3 granules becomes roughly 150, and a `content_id`
   leading key starts to prune a content-filtered query for real while a time-windowed unfiltered
   query still scans everything. That is the measurement that should decide the key, and it does
   not exist yet.
3. **At 100x a projection is the wrong instrument.** 2.2M rows per dashboard request needs a
   pre-aggregate, which is what `audience_minute_snapshot` and `content_entry_cohorts` are for: a
   minute or cohort grain is bounded by time and dimensions rather than by session count.

Compare with the concurrency curve, whose read does **not** shrink with the window because a
cumulative sum must be seeded from the first minute of the series `[V:seeding_position]`. That one
is a countdown against table size; this one scales with the window. Different failure modes, and
`docs/STATUS.md` tracks the first as a deadline.

## Reproduce

```bash
CH_DATABASE=phoenix_next ./scripts/refresh_insights.sh    # rebuild, with post-conditions
CH_DATABASE=phoenix_next ./scripts/validate_insights.sh   # Gate A, every pair, zero diffs
CH_DATABASE=phoenix_next ./scripts/bench_insights.sh      # Gate B, every benchmark query
```
