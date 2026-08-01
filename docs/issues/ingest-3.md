# ingest-3: insert batches are about 66 rows, against a 10,000 row guideline

**Status:** open, documented not fixed. Ingest is owned by a teammate and this repo does not
touch it.
**Filed:** 2026-08-01 · **Evidence:** `clickhouse_rules_audit` in `evidence/LEDGER.tsv`

## What was measured

`[V:clickhouse_rules_audit]` Over the four hours covering the replay run, 834 inserts landed in
`phoenix.raw_events_landing` with:

| | Rows per insert |
|---|---:|
| average | **66** |
| minimum | 34 |
| maximum | 500 |

Read from `system.query_log` where `query_kind = 'Insert'`.

## Command

```
./scripts/ch.sh --format TSVWithNames --query "
SELECT round(avg(written_rows)), min(written_rows), max(written_rows), count()
FROM clusterAllReplicas(default, system.query_log)
WHERE type='QueryFinish' AND query_kind='Insert' AND event_time > now() - INTERVAL 4 HOUR
  AND has(tables,'phoenix.raw_events_landing')"
```

## Why it matters

The ClickHouse guidance (`insert-batch-size`) is 10,000 to 100,000 rows per insert. At 66
rows, this is roughly **150x below the lower bound**.

Each insert creates a part. Small parts mean more parts to merge, more merge CPU, and a
faster path to `too many parts` at scale. `[V:inventory_phoenix]` `raw_events` currently
carries 11 active parts for 960,851 rows, which is a symptom of the same thing.

**It is not currently hurting anything measurable**, and that is worth saying plainly rather
than escalating a rule violation into an incident. The corpus is small, merges are keeping up,
and no query in the benchmark set reads `raw_events` at all. This is a scale concern, not a
present defect.

**It would hurt at 100x**, which is the scale the judges have said they will ask about, so it
is better named than discovered.

## Recommendation, which is the owner's to accept or decline

`[A]` Two options, in order of effort:

1. **Enable async inserts** (`async_insert = 1`, `wait_for_async_insert = 1`). ClickHouse then
   buffers small inserts server-side and flushes them as larger parts, which is the remedy the
   `insert-async-small-batches` guidance names for exactly this shape: high-frequency small
   batches from a producer that cannot easily batch further. No producer change.
2. **Batch in the producer**, accumulating a few thousand rows or a few seconds before
   inserting. Better control, more work, and it raises end-to-end latency by the buffer window.

**Falsified by:** a measurement showing merge pressure is not a constraint at target scale.
**Decided by:** the ingest owner.

Not done here, because changing insert behaviour means changing the ingest script, and that is
outside this work's ownership boundary.
