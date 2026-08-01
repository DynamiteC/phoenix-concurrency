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

`[V:ingest_probe]` The stream had been running, and its shape is that of a scripted replay
loop rather than either a hand-run bulk load or an always-on production feed. Measured from
`system.query_log` over the run: **26 to 27 insert queries per minute**, delivering roughly
**1,280 rows per minute**, with inter-insert gaps of **2 seconds (594 times) or 3 seconds
(206 times)** and only 8 gaps of any other length. That cadence held from 11:37 to 13:20,
then stopped. It delivered 55,293 rows across 1,546 sessions.

That distinction matters for what may be claimed about freshness. While a run is in
progress, insert-to-visible is seconds, because the materialized views are synchronous with
the insert. But whether a run is in progress is operator-controlled, so **end-to-end
freshness is bounded by when somebody starts the loop, not by the pipeline**. A freshness
SLA must not be quoted off this.

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

The ingest owner to start a run when the gate needs to be upgraded. Nothing needs fixing if
the loop is meant to be started on demand; this is then expected behaviour, not an incident.

`[A]` The stop is an operator action rather than a crash. Supporting evidence:
`system.query_views_log` shows **no exceptions on any materialized view**, the final inserts
completed normally (`QueryFinish`), and the cadence was metronomic right up to the last one
rather than degrading. **Falsified by:** an error in the producer's own logs, which are
outside this repo. **Decided by:** the ingest owner.

## Consequence for the demo, worth stating before someone is asked in Q and A

`[A]` A replay loop an operator starts is a legitimate and standard way to demonstrate a
streaming pipeline, and the problem statement explicitly suggests replaying a live-event day.
What it is not is a production feed, and describing it as one during a demo invites a
question that cannot be answered well. Say "replay of a recorded day at roughly 1,280 rows
per minute", which is both true and more impressive than a vague claim. **Decided by:** the
person presenting.
