# Corrections

Every headline number this project published and later found to be wrong, what caught it, and
what fixed it.

**This file is kept deliberately.** It is the only way a reader can tell a team that validated
from a team that got lucky. A repo with no corrections file either never checked its numbers
or deleted the evidence that it had to. Nothing here is softened, and no corrective prose has
been removed elsewhere to make this page look shorter.

The pattern is worth naming, because it repeats: **in every single case the number was
plausible, published, and unchecked.** None was a typo. Each was produced by a query that ran
successfully and returned the wrong thing.

## The headline numbers

| Claim | Published | Correct | Factor | Caught by | Fixed in |
|---|---:|---:|---|---|---|
| Peak concurrent sessions | 3,323 | **2,829** | 1.17x over | oracle parity after the neutral-heartbeat fix | `7bc3a51` |
| Naive overcount at peak | 12.6% | **32.3%** | 2.6x under | `naive_vs_foreground`, `naive_baseline` | `7bc3a51`, `a5bca8c` |
| Phantom audience minutes | 1,272 | **1,592** | 1.25x under | `naive_vs_foreground` | `7bc3a51` |
| Oracle-parity minutes | 3,874 | **3,664** | 1.06x over | `oracle_parity` | `c228db4` |
| Phantom minutes, second pass | 1,590 | **1,592** | 2 minutes | `naive_vs_foreground` | `1acb1f0` |
| Distinct `event` values | 46 | **47** | 1 value | `frozen_slice_stability` | `e528698` |
| **Average concurrency, full day** | **246.98** | **88.20** | **2.8x over** | `filter_shapes` | `a5bca8c` |
| Average concurrency, curve query | 185.95 | **88.20** | 2.1x over | `filter_shapes` | `a5bca8c` |

## What went wrong, case by case

### Neutral telemetry was cancelling pauses (peak, overcount, phantom minutes)

The state machine originally treated every event as decisive. Most of the 47 distinct `event`
values are neutral telemetry (`dropped-frames`, `network-bandwidth`, `buffer-health`), and
they were resolving a paused session back to active. Three headline numbers moved at once
when neutral events were made to carry the previous state forward instead: peak fell from
3,323 to 2,829, overcount rose from 12.6 to 32.3 percent, phantom minutes rose from 1,272 to
1,592.

**Why it survived.** Every one of those numbers was individually plausible. Nothing looked
broken, because a slightly-too-high concurrency curve looks exactly like a concurrency curve.

### The average denominator, and why peak hid it for so long

The worst of the set, and the most instructive. Measured over 2026-07-26 unfiltered:

- `benchmark/peak_average.sql` reported **246.98**. It applied no densification at all, so it
  averaged only the minutes where a delta happened to exist.
- `benchmark/concurrency.sql` reported **185.95**. It used `WITH FILL` but without `FROM` and
  `TO`, so the fill spanned only the first to the last row that already existed: 683 minutes
  instead of 1,440.
- The correct value over the full 1,440 minutes is **88.20**.

**Peak was 2,829 in all three.** That is the whole lesson. Concurrency only changes at a delta
boundary, so the maximum over boundaries **is** the maximum over minutes, and peak is immune
to a sparse denominator. Average is not. A single correct-looking number sitting next to a
wrong one is what kept this alive.

The general rule, now written into `ground_state.sh`: **any metric computed by counting curve
rows is counting boundaries, not minutes.** The same bug appeared a third time while building
the fix, in a new metric of my own: `minutes_with_audience` returned 1,413 by counting rows
against the oracle's 3,664. Gap weighting returned 3,664 and agreed.

### Phantom minutes 1,590 vs 1,592: a definition, not an error

Two ways to count minutes where naive shows an audience and the corrected curve does not.
Subtracting the totals (5,254 minus 3,664) gives 1,590. Counting minutes matching the
predicate directly gives **1,592**. The gap is exactly the two `inverted_minutes`: minutes
with a corrected audience and no naive one, which arise because a foreground interval runs to
`last_event + tolerance` and can reach a minute the session's last raw event did not.

Both figures ship in the artifact so the gap is visible rather than reconciled away. 1,592 is
the one to quote.

### Oracle parity 3,874 to 3,664

The earlier figure predated the millisecond-collapse fix. 29 percent of events share a second
with another event, and at second resolution tie order was arbitrary, so pause and resume in
the same second resolved differently between runs. Collapsing to one row per
`(session, millisecond)` with "close beats open at the same instant" made it deterministic and
cut intervals from 851,919 to 364,769.

### A timezone artifact, worth recognising on sight

`docs/assumptions.md` carried a data span of 07-14 21:13 to 07-26 17:00 and a peak minute of
16:29, against the correct 07-14 15:43, 07-26 11:30 and 10:56. Every one of those is **exactly
+5:30**: Asia/Kolkata against UTC. The service runs UTC and a local `clickhouse local` run
does not, so any ad-hoc query outside the pinned scripts was 5.5 hours off. `scripts/ch.sh`
now pins `--session_timezone UTC` on every call.

## Two structural failures, not number failures

### The schema was believed instead of read

An out-of-band `ALTER` added `ingested_at` to `raw_events` and `content` mid-run. The
committed DDL said 13 columns, the live table had 14, and every scratch query doing `SELECT *`
died on `NUMBER_OF_COLUMNS_DOESNT_MATCH` for most of a day.

**Rule now:** read `system.columns` before writing SQL against a table. `scripts/inventory.sh`
does it in one command, and its errors are deliberately not redirected to `/dev/null`.

### A freshness key that would have inverted the dataset

`ingested_at` was adopted as a freeze key on the assumption that it held a stored value. It
does not. It was added by `ALTER` after the corpus was loaded, ClickHouse does not rewrite
existing parts, so `DEFAULT now()` is evaluated at **read** time and the column equals the
reading query's own wall clock.

`[V:ingested_at_nondeterminism]` Filtering on it retained **0 of 905,558** corpus rows and
**all** live rows. Exactly backwards. This one was caught before it shipped, by the rule that
a freshness key must be verified rather than assumed.

## One gate that failed, and was itself the bug

`naive_baseline_gate` sat in the ledger as a committed **FAIL** from `1acb1f0`. It required
the naive and corrected delta tables to span identical ranges, and they differ by one minute
because a foreground interval runs to `last_event + tolerance`.

The data was right and **the gate was mis-calibrated.** It now clips the comparison to the
overlapping range and reports the excluded minute rather than halting. It passes, and
reproduces every headline exactly: peak 3,742 against 2,829, overcount 32.3 percent, phantom
minutes 1,592. `[V:naive_baseline]`

The original FAIL artifact is kept and still referenced. A gate that failed, was examined, and
was corrected is a better story than a gate that never failed, and deleting the failing
artifact would have removed the only evidence that the check was ever exercised.
