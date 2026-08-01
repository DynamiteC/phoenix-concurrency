# ingest-2: the live stream stopped at 13:20:52 UTC

**Status:** open, needs the ingest owner. Not fixed here: ingest is a teammate's and this
repo does not touch it.
**Filed:** 2026-08-01 · **Evidence:** `ingest_probe`, `frozen_slice_stability` in
`evidence/LEDGER.tsv`

## What was measured

`[V:ingest_probe]` `phoenix.raw_events` held **960,851 rows at every sample** across five
separate probes between 13:39 and 13:44 UTC, spanning 41 seconds of continuous sampling in
one run and 10 seconds in another. `rows_arrived = 0`.

`[V:ingest_probe]` `max(event_timestamp)` was **`2026-08-01 13:20:21.559` at every sample**,
unchanged across the same period.

`[V:ingest_probe]` `last_insert_into_raw_events = 2026-08-01 13:20:52`, read from
`system.query_log` where `query_kind = 'Insert'`. At the time of the probe that was roughly
23 minutes earlier.

`[V:ingest_probe]` The stream had been running: 878 insert queries wrote 2,624,019 rows into
the landing table in the preceding two hours, and it delivered 55,293 rows across 1,546
sessions between 11:37 and 13:20 before stopping.

## Command

```
./scripts/ingest_probe.sh 3 20
```

## Why it matters

The Phase 1 gate ran while the stream was idle. It compared 33 frozen-slice metrics across
two runs 60 seconds apart and found **0 differing lines**, which is the right answer, but it
reported `verdict = PASS_BUT_INGEST_IDLE` rather than `PASS`.

That distinction is deliberate and it is the point of the gate. The claim being tested is
"the frozen slice does not move *while ingest writes to the same table*". A run with no
writes cannot test that claim. It demonstrates stability against nothing, and recording it
as a pass would be exactly the kind of unearned confidence this repo has already paid for
once. See `docs/corrections.md`.

The gate is written so that re-running it during a live window upgrades the verdict with no
code change:

```
./scripts/frozen_gate.sh 120
```

`PASS` requires both `differing_lines = 0` and `rows_ingested_between_runs > 0`.

## What is needed

The ingest owner to say whether the stop was intentional. If the stream is meant to keep
running through the submission, it needs restarting, and the gate should be re-run during a
live window to convert `PASS_BUT_INGEST_IDLE` into `PASS`.

`[A]` The stop is assumed to be an operational pause rather than a crash, because
`system.query_views_log` shows **no exceptions on any materialized view** and the final
inserts completed normally (`QueryFinish`). **Falsified by:** an error in the producer's own
logs, which are outside this repo. **Decided by:** the ingest owner.
