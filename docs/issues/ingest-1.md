# ingest-1: the live stream stamps wall-clock arrival time into `event_timestamp`

**Status:** open, documented not fixed. Ingest is owned by a teammate and this repo does not
touch it.
**Filed:** 2026-08-01 · **Evidence:** `ingest_probe` in `evidence/LEDGER.tsv`

## What was measured

`[V:ingest_probe]` The live slice in `phoenix.raw_events` carries `event_timestamp` values
from `2026-08-01 11:37:57.447` to `2026-08-01 13:20:21.559`. That window is the wall-clock
period during which ingest was running, not a span of source event time.

`[V:ingest_probe]` `session_start_epoch` on the same rows runs
`2026-08-01 11:37:19.898` to `2026-08-01 13:20:18.556`, so the producer is stamping both
time columns from the same clock. The two columns agree with each other and with the server,
and disagree with the corpus.

`[V:ingest_probe]` The validated corpus ends at `2026-07-26 11:30:04.847`. There is a gap of
roughly six days between the end of the corpus and the start of the live slice, and no
events in between.

`[V:ingest_probe]` `sessions_spanning_the_boundary = 0`. No `video_session_id` has events on
both sides of `2026-08-01`. The live slice is a disjoint set of 1,546 sessions
(55,293 rows), not a continuation of the 10,866 corpus sessions.

## Command

```
./scripts/ingest_probe.sh 3 20
```

## Why it matters

Two consequences, one benign and one that would have been expensive.

The benign one: because the live rows are disjoint in both time and session id, the
predicate `event_timestamp < '2026-08-01'` separates corpus from stream exactly. No session
gets half-counted, so the validated numbers are recoverable from the shared table without
moving anyone's data. That is what makes the isolation decision in `GROUND_STATE.md` cheap.

The expensive one, avoided: if these rows had instead been *replayed corpus events* carrying
arrival timestamps, they would have been silent duplicates of sessions already counted, and
concurrency would have been inflated by an amount no invariant in this pipeline would catch.
Closure (`sum(delta) = 0`) would still hold. The peak would simply have been wrong. The
measurement above is what rules that out, and it is worth re-running on the unseen day
before trusting any number from it.

## What would change this finding

`[A]` If the teammate changes the producer to stamp source event time, the live slice would
start overlapping the corpus range and `sessions_spanning_the_boundary` could become
non-zero. **Falsified by:** `./scripts/ingest_probe.sh` reporting a non-zero
`sessions_spanning_the_boundary`, or a `live.first_event_timestamp` earlier than
`frozen.last_event_timestamp`. **Decided by:** the ingest owner.

## Recommendation, not a finding

Not our call to make, and deliberately not made here: if the stream is meant to simulate a
fresh day of source data, `event_timestamp` should come from the source record and arrival
time should live in its own column. Filed for the owner to decide.
