# Checkpoint table: built, measured, parked

Parked 2026-08-02, deliberately, with the measurements that justify it.

## What it was for

`concurrency_curve.sql` seeds its running sum from the beginning of history, because a session
that opened before the window is still watching inside it. A one-hour window therefore costs the
same as a whole-corpus window, by design. That is the one thing in this system that genuinely
breaks at 100x, and no ordering key, projection or skip index helps, because the query really does
want all those rows.

## What was built

A `concurrency_checkpoints` table holding the running total per dimension tuple at each boundary,
plus a builder and a `concurrency_curve_checkpointed.sql` variant. Parity was **exact**: 1,440
rows, peak 22,416, identical checksum against the original on the unseen day.

## Why it is parked and not shipped

1. **Daily boundaries bought 2 percent.** 133,765 rows read becomes 131,147. The unseen day IS one
   day, so a daily boundary bounds nothing.
2. **Hourly boundaries do not build.** The builder `CROSS JOIN`s deltas against boundaries, and the
   unseen day's dirty tail spans 2014-12-31 to 2026-08-03. That is roughly 100,000 hourly
   boundaries against 133,784 delta rows: about 13 billion combinations. The build does not finish.

## What the real fix looks like

The `CROSS JOIN` is the wrong shape. Compute the running total once with a window function over
the delta table ordered by minute and sample it at boundaries, which is one pass instead of a
product. Also bound boundaries to the DENSE region rather than to min..max, so a single 2014 event
cannot manufacture 100,000 empty boundaries.

The interim mitigation that IS shipped: `MAX_WINDOW_DAYS = 31` in `frontend/src/lib/filters.ts`
clamps any request window, so the unbounded read has a ceiling even though the seed is still read
from the beginning.
