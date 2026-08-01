# Database details

**The ClickHouse Cloud service behind this project, as it actually exists.**
Server `26.2.1.525`, primary database `phoenix`. Structural facts read live from
`system.tables`, `system.columns` and `system.parts` on 2026-08-01, not from the files in
`sql/`: those have drifted from the live server before and cost a day.

This document is meant to be readable on its own. If you want the field-by-field business
meaning of the two source CSVs, that is [`problem/dataset_details.md`](problem/dataset_details.md).
If you want only the reasoning narrative without the physical reference,
[`DATA_MODEL.md`](DATA_MODEL.md) is shorter. Everything needed to understand what is in the
database and why it is shaped that way is below.

## Two sets of numbers, and which one you are reading

Live ingest keeps writing into `phoenix.raw_events` while we work. So every count exists twice:

| | Meaning | Stable? |
|---|---|---|
| **Live** | the whole table, right now | no, it grows every minute |
| **Frozen slice** | `event_timestamp < 2026-08-01` | yes, this is the validated corpus |

Every validation and benchmark figure in this repo is on the **frozen slice**. Live figures are
quoted below only to describe physical storage (parts, bytes), and they carry the timestamp of
the read. That is why a row count here can differ from the same table's count in
`DATA_MODEL.md`: at the read below, `raw_events` held **960,851 live rows** of which
**905,558 are frozen**, spanning `2026-07-14 15:43:58.144` to `2026-08-01 13:20:21.559`,
across 12,412 sessions and 11,164 users.

The freeze predicate is `event_timestamp < {frozen_before:String}`, injected into every query by
`scripts/ch.sh`. It is deliberately **not** `ingested_at`. `ingested_at` was added by a later
`ALTER`; ClickHouse does not rewrite existing parts, so for pre-`ALTER` rows the `DEFAULT now()`
is evaluated at **read** time and the column equals the reading query's wall clock. Filtering on
it erases the entire validated corpus and keeps only the live rows, the exact inversion of what
was wanted. `[V:ingested_at_nondeterminism]`

## Connecting

Credentials live in `.env`, which is gitignored. Copy `.env.example` and fill it in from the
ClickHouse Cloud console:

```
CH_HOST=xxxx.region.clickhouse.cloud
CH_PORT=9440
CH_USER=default
CH_PASSWORD=
CH_DATABASE=phoenix
```

Nothing talks to the service directly. `scripts/ch.sh` is the only entrypoint, and it does three
things nobody should have to remember:

```bash
./scripts/ch.sh --query "SELECT 1"
./scripts/ch.sh --queries-file sql/schema/01_raw_events.sql
CH_DATABASE=phoenix_unseen ./scripts/ch.sh --query "SHOW TABLES"
FROZEN_BEFORE=2026-08-02 ./scripts/ground_state.sh
```

1. Injects `--param_frozen_before` (default `2026-08-01`), unless the caller passed it explicitly.
   The frozen slice is **one variable**, not a literal scattered through the SQL tree.
2. Pins `--session_timezone UTC`. Local runs are Asia/Kolkata and the service is UTC. Pinning both
   ends removes an entire class of off-by-five-and-a-half-hours.
3. Lets a caller-set `CH_DATABASE` win over `.env`, which is what makes one database per dataset
   generation cheap.

Creating and loading:

```bash
./scripts/init_db.sh                                    # applies sql/schema/*.sql to $CH_DATABASE
./scripts/init_db.sh phoenix_unseen                     # a fresh database for a new generation
./scripts/load.sh --dry-run data/some.csv               # DESCRIBE + count via clickhouse local
./scripts/load.sh data/some.csv raw_events_landing phoenix_unseen
```

`load.sh` compares source rows against loaded rows on every run. A CSV that loses rows to a
quoting error loads without complaint, and the loss stays invisible until a number is wrong much
later.

## The databases on this service

```
phoenix                     the real one: validated corpus + live ingest
phoenix_parity_incr         same schema, built by the INCREMENTAL path, for oracle parity
phoenix_open_test           open-session fixture: sessions still running at the cutoff
phoenix_open_truth          one-pass batch truth for the same fixture, to diff against
phoenix_scratch_rehearsal   throwaway, produced by rehearsing the unseen-day runbook
phoenix_scratch_openday     throwaway, partial-day rebuild scratch
```

Plus the ClickHouse-supplied `default`, `system`, `information_schema` and `INFORMATION_SCHEMA`.

**One database per dataset generation.** This is the structural replacement for the social rule
"announce your DDL", which has now failed twice: an out-of-band `ALTER` added a column to a table
mid-run and cost a day. It also makes the unseen day two commands

```bash
./scripts/init_db.sh phoenix_unseen
./scripts/load.sh data/unseen.csv raw_events_landing phoenix_unseen
```

rather than an improvised pipeline at hour 22. The full sequence is
[`RUNBOOK_UNSEEN_DAY.md`](RUNBOOK_UNSEEN_DAY.md), rehearsed end to end with per-step wall clock
`[V:runbook_rehearsal]`.

`phoenix_parity_incr` deserves a note: it is the same schema built entirely by the incremental
path (`03_derive_incremental.sql`) rather than the batch path, so `foreground_intervals` is empty
in it **by design**. Diffing its serving output against `phoenix` is how we know the two paths
agree `[V:oracle_parity]`.

**Every engine is a Cloud `Shared*` variant.** The DDL in `sql/schema/` says `MergeTree`,
`SummingMergeTree`, `CollapsingMergeTree`; ClickHouse Cloud substitutes `SharedMergeTree` and
friends, backed by shared object storage with a `/clickhouse/tables/{uuid}/{shard}` path and a
`{replica}` macro. Semantics are the same. It surprises people reading `SHOW CREATE TABLE` for
the first time, which is the only reason it is mentioned.

## Dataflow

```mermaid
flowchart TD
    CSV["ch-hackathon-raw-data.csv<br/>232 MB"] -->|load.sh| LAND
    CCSV["ch-hackathon-content-data.csv<br/>33,464 rows"] -->|load.sh| CONTENT[("content<br/>ReplacingMergeTree<br/>33,464 rows, 220 KiB")]

    LAND["raw_events_landing<br/>ENGINE = Null<br/>epoch millis as Int64"] -->|raw_events_mv| RAW
    RAW[("raw_events<br/>MergeTree<br/>960,851 live / 905,558 frozen<br/>4.10 MiB, PARTITION BY day")]

    RAW --> STATE{{"event_state (VIEW)<br/>3-bucket state machine<br/>millisecond resolution"}}
    STATE -->|01_derive_intervals| FI
    CONTENT -.->|LEFT JOIN for video_type| FI

    FI[("foreground_intervals<br/>MergeTree<br/>631,103 rows, 2.95 MiB")]
    FI -->|02_merge_runs| SMR
    STATE -->|03_derive_incremental<br/>retract then re-assert| SMR

    SMR[("session_minute_runs<br/>CollapsingMergeTree(sign)<br/>19,149 asserted / 22,145 physical")]
    SMR -->|concurrency_deltas_mv| CD[("concurrency_deltas<br/>SummingMergeTree(delta)<br/>1,580 minutes, 60 KiB")]
    SMR -->|04_merge_user_runs| UMR[("user_minute_runs<br/>CollapsingMergeTree(sign)<br/>18,145 asserted")]
    UMR -->|user_concurrency_deltas_mv| UCD[("user_concurrency_deltas<br/>SummingMergeTree(delta)<br/>1,534 minutes, 60 KiB")]

    CD --> SERVE["sql/queries/serving/<br/>cumulative sum, seeded<br/>peak and both averages"]
    UCD --> SERVE
    SERVE --> DASH["demo dashboard"]

    style RAW fill:#1f2937,color:#fff
    style CD fill:#065f46,color:#fff
    style UCD fill:#065f46,color:#fff
    style SERVE fill:#1e3a5f,color:#fff
```

The shape to notice: **the pipeline narrows by three orders of magnitude.** Nearly a million
events become a 60 KiB serving table, because cost tracks interval boundaries rather than watch
time. A three-hour session costs the same two delta rows as a two-minute one.

## Object reference

Fifteen objects in `phoenix`, in pipeline order. Sizes are compressed unless stated; parts are
active parts at the 2026-08-01 read.

### `raw_events_landing`

**Engine.** `Null`. It stores nothing. Rows inserted into it are handed to the attached
materialized view and discarded.

**Why it exists.** The CSV carries `event_timestamp` and `session_start_epoch` as **epoch
milliseconds**, which is an `Int64`, not a timestamp. The landing table accepts the file exactly
as delivered and the view does the conversion, so the load is `INSERT ... FORMAT CSVWithNames`
with no preprocessing step to get wrong on the unseen day.

| Column | Type |
|---|---|
| `content_id` | `Int64` |
| `video_session_id` | `String` |
| `user_id` | `String` |
| `event_type` | `LowCardinality(String)` |
| `event` | `LowCardinality(String)` |
| `event_timestamp` | `Int64` (epoch millis) |
| `platform` | `LowCardinality(String)` |
| `app_version` | `LowCardinality(String)` |
| `country` | `LowCardinality(String)` |
| `audio_language` | `LowCardinality(String)` |
| `subtitle_language` | `LowCardinality(String)` |
| `player_version` | `LowCardinality(String)` |
| `session_start_epoch` | `Int64` (epoch millis) |

Column order matches the CSV header, which is why `content_id` leads here and not in `raw_events`.

**Written by.** `scripts/load.sh`. **Read by.** `raw_events_mv` only.

### `raw_events_mv`

**Engine.** `MaterializedView`, `raw_events_landing` to `raw_events`.

```sql
SELECT video_session_id, user_id, content_id, event_type, event,
       fromUnixTimestamp64Milli(event_timestamp) AS event_timestamp,
       platform, app_version, country, audio_language, subtitle_language, player_version,
       fromUnixTimestamp64Milli(session_start_epoch) AS session_start_epoch
FROM phoenix.raw_events_landing
```

Millis to `DateTime64(3)`, nothing else. No filtering, no dropping: whatever arrives is stored.

### `raw_events`

**Holds.** Every event exactly as delivered, with epoch millis converted to `DateTime64(3)`.

**Engine.** `SharedMergeTree`.
**`ORDER BY (video_session_id, event_timestamp)`**, **`PARTITION BY toYYYYMMDD(event_timestamp)`**.

Ordered by session because every derivation step is per-session and walks a session's events in
time order. Partitioned by day so a day can be dropped or replaced without touching the rest,
which is what makes the unseen day a load rather than a migration.

| Column | Type | Default | Meaning |
|---|---|---|---|
| `video_session_id` | `String` | | one video playback; session concurrency is derived from it |
| `user_id` | `String` | | user concurrency is derived from it |
| `content_id` | `Int64` | | joins to `content`; also a filter dimension |
| `event_type` | `LowCardinality(String)` | | `VideoSessionStart`, `VideoPlay`, `VideoHeartbeat`, `AppBackgrounded`, `AppForegrounded`, `VideoSessionEnd`, `VideoError` |
| `event` | `LowCardinality(String)` | | the specific event within that type (`pause`, `resume`, `AdPause`, ...) |
| `event_timestamp` | `DateTime64(3)` | | the only time column that means anything; millisecond resolution matters, see `event_state` |
| `platform` | `LowCardinality(String)` | | filter dimension |
| `app_version` | `LowCardinality(String)` | | filter dimension |
| `country` | `LowCardinality(String)` | | filter dimension |
| `audio_language` | `LowCardinality(String)` | | filter dimension |
| `subtitle_language` | `LowCardinality(String)` | | filter dimension |
| `player_version` | `LowCardinality(String)` | | filter dimension |
| `session_start_epoch` | `DateTime64(3)` | | session start, available on every event |
| `ingested_at` | `DateTime` | `now()` | **not in the committed DDL**, see below |

**Costs.** 960,851 live rows in **4.10 MiB compressed** against 159.08 MiB uncompressed, 10 active
parts. 232 MB of CSV to 4.10 MiB is roughly 56x. `[V:inventory_phoenix]` The frozen slice is
905,558 of those rows.

**Read by.** `event_state`, the derivation pipeline, and the validation oracle. **Not by any
dashboard query** `[V:filter_shapes]`. No serving query touches this table.

**Watch out.** `ingested_at` is the out-of-band `ALTER` column. It is not usable as a freeze key
for the reason given at the top, and `GROUND_STATE.md` section 3 has the full account.

### `event_state` (a view, not a table)

**Holds.** Nothing. It is the shared state machine, evaluated on read.

| Column | Type | Meaning |
|---|---|---|
| `video_session_id` | `String` | |
| `ts` | `DateTime64(3)` | |
| `is_open` | `UInt8` | foreground and playing: the definition we ship |
| `is_open_pause_active` | `UInt8` | the same, but a pause does not stop the clock |

**What it does.** Collapses events to one row per `(video_session_id, millisecond)`, then carries
the last decisive state forward with `argMax(...) OVER (PARTITION BY video_session_id ORDER BY ts)`.
Three buckets:

- **closes playback**: `event_type IN ('AppBackgrounded', 'VideoSessionEnd', 'VideoError')`, and for
  `is_open`, a `VideoHeartbeat` with `event IN ('pause', 'speed-pause', 'AdPause')`
- **opens playback**: `event_type IN ('VideoSessionStart', 'VideoPlay', 'AppForegrounded')`, and a
  `VideoHeartbeat` with `event IN ('resume', 'speed-resume', 'AdResume')`
- **everything else is neutral** and carries the previous state forward

The two output columns differ in exactly one place: `is_open_pause_active` omits the pause values
from the closing bucket. Ad handling was measured rather than assumed `[V:adpause_impact]`.

**Why milliseconds.** 29 percent of events share a second with another event. At second resolution
the tie order is arbitrary, so a pause and a resume in the same second resolved differently on
different runs. Collapsing at millisecond resolution with "close beats open at the same instant"
made it deterministic.

**Why neutral is the default.** An unrecognised value can never start counting someone as
watching. The live stream has already introduced event values absent from the corpus, and every
one was absorbed correctly with no code change `[V:ingest_probe]` `[V:unknown_vocabulary]`.

**Do not edit this file.** It is validated against a brute-force oracle at zero diffs
`[V:oracle_parity]`. If you believe it is wrong, escalate rather than improve it.

### `foreground_intervals`

**Holds.** One row per contiguous foreground interval, with dimensions already attached.

**Engine.** `SharedMergeTree`, **`ORDER BY (video_session_id, interval_start)`**, no partition.
Ordered by session because its only consumer, the merge step, groups by session.

| Column | Type |
|---|---|
| `video_session_id` | `String` |
| `user_id` | `String` |
| `content_id` | `Int64` |
| `platform`, `country`, `app_version`, `video_type` | `LowCardinality(String)` |
| `interval_start` | `DateTime` |
| `interval_end` | `DateTime` |

`video_type` arrives here by `LEFT JOIN` to `content`. `LEFT`, not `INNER`: an event whose content
is missing from the metadata is still counted as viewing. Dropping real playback because a
metadata row is absent would be a correctness bug, not a data-quality improvement.

**Written by.** `sql/pipeline/01_derive_intervals.sql`, the batch path only. The incremental path
bypasses it, so in an incrementally-built database (`phoenix_parity_incr`) this table is empty by
design.

**Costs.** 631,103 rows, **2.95 MiB compressed** against 97.03 MiB uncompressed, 2 parts. On the
frozen slice, 599,137 rows `[V:frozen_slice_stability]`.

**The boundary rule, validated, do not change:**

- `interval_start` inclusive, `interval_end` exclusive
- `interval_end = least(if(next_ts > ts, next_ts, ts + tol), ts + tol)`, so the 90-second gap
  tolerance **does** extend the tail
- tolerance is 90s, chosen from the observed gap distribution (p90 40s, p99 76s), not from the
  nominal 60s heartbeat: 60s would falsely split about 1 percent of normal traffic

**Watch out, and this looks worse than it is.** 253,590 of 599,137 frozen intervals (42.3 percent)
are zero-length, `interval_end = interval_start` `[V:frozen_slice_stability]`. That is storage
precision, not a logic error: this table stores second-resolution `DateTime` while `event_state`
runs at milliseconds, so a sub-second segment truncates to a point. It changes no output, because
`timeSlots(t, 0, 60)` returns exactly one slot, and a viewer seen at 10:00:30 was indeed watching
during the 10:00 minute. The invariant that would catch real damage is
`max_runs_per_session_minute`, and it is 1.

### `session_minute_runs`

**Holds.** One row per contiguous run of active minutes per session, `run_end` inclusive.

**Engine.** `SharedCollapsingMergeTree(sign)`,
**`ORDER BY (video_session_id, run_start, run_end)`**.

| Column | Type | Default |
|---|---|---|
| `video_session_id` | `String` | |
| `user_id` | `String` | |
| `content_id` | `Int64` | |
| `platform`, `country`, `app_version`, `video_type` | `LowCardinality(String)` | |
| `run_start` | `DateTime` | |
| `run_end` | `DateTime` | |
| `sign` | `Int8` | `1` |

**Written by.** `02_merge_runs.sql` for full rebuilds, and `03_derive_incremental.sql` for
arrivals, which writes a `sign = -1` retraction for every previously asserted run of a touched
session and then re-asserts with `sign = +1`.

Collapsing rather than mutation because a late heartbeat must be able to revise a published minute
without an `ALTER TABLE ... UPDATE`, which on a table this size would be a mutation storm at 100x.
Absorption of open sessions is verified against one-pass batch truth `[V:open_sessions]`, and the
before-and-after of a live update is attributed to exactly the sessions that received events
`[V:open_session_update]`.

**Costs.** 22,145 physical rows, 19,149 asserted, 1001.81 KiB, 2 parts. On the frozen slice,
17,604 asserted `[V:frozen_slice_stability]`.

**Watch out. Never use `count()` here.** It reads physical rows including retractions. The correct
measure is `sum(sign)` `[V:ingest_probe]`.

### `user_minute_runs`

Same idea, keyed by user instead of session, so a user watching on two devices is one row rather
than two. **`SharedCollapsingMergeTree(sign)`, `ORDER BY (user_id, run_start, run_end)`.** Columns
are `user_id`, `platform`, `country`, `video_type`, `content_id`, `app_version`, `run_start`,
`run_end`, `sign`. Written by `04_merge_user_runs.sql`. 18,145 rows, 476.14 KiB, 1 part.
`sum(sign)`, never `count()`.

### `concurrency_deltas_mv` and `user_concurrency_deltas_mv`

**Engine.** `MaterializedView`, from the corresponding runs table.

```sql
SELECT platform, country, video_type, content_id, app_version,
       d.1 AS minute, d.2 * sign AS delta
FROM phoenix.session_minute_runs
ARRAY JOIN [(run_start, 1), (run_end + toIntervalMinute(1), -1)] AS d
```

That is the whole trick. Each run becomes exactly two rows: `+1` when it starts, `-1` the minute
after it ends. `* sign` means a retraction automatically emits the inverse pair, so a revised run
cancels itself out with no bookkeeping. Both views are healthy with zero exceptions in
`system.query_views_log` `[V:inventory_phoenix]`.

### `concurrency_deltas` and `user_concurrency_deltas`

**Holds.** `+1` at `run_start` and `-1` at `run_end + 1 minute`, per dimension tuple. Summing these
in minute order reproduces the concurrency curve.

**Engine.** `SharedSummingMergeTree(delta)`.

| Column | Type |
|---|---|
| `platform`, `country`, `video_type` | `LowCardinality(String)` |
| `content_id` | `Int64` |
| `app_version` | `LowCardinality(String)` |
| `minute` | `DateTime` |
| `delta` | `Int32` |

**Read by.** Every dashboard query, and nothing else.

**The key, and this is the important one.**
**`ORDER BY (platform, country, video_type, content_id, app_version, minute)`.**

Dimensions lead and `minute` sits last, deliberately. A cumulative sum must be seeded by every
delta before the requested window, so a time predicate **cannot** prune it: starting the sum inside
the window loses every session that opened earlier and is still watching. What can prune is a
dimension filter, so dimensions occupy the prunable prefix. Measured: a `platform` filter cuts to
2 of 4 granules and 16,384 rows where unfiltered reads 26,904 `[V:filter_shapes]`.

The honest cost of that choice is in [`problem/DESIGN.md`](problem/DESIGN.md) section 7: only
`platform` prunes, because it leads. `content_id` is fourth, and a content-only filter reads the
whole table. At 60 KiB that is a rounding error today; at 100x it is the first thing to revisit,
most likely with a projection ordered content-first.

**Costs.** `concurrency_deltas` 26,904 rows covering 1,580 distinct minutes in **60.30 KiB**;
`user_concurrency_deltas` 25,461 rows over 1,534 minutes in 60.09 KiB. Both currently balance to
`sum(delta) = 0`, spanning `2026-07-14 15:43` to `2026-08-01 13:21`.

**Watch out.** `count()` is meaningless here too: `SummingMergeTree` collapses rows on merge, so it
moves with merge timing rather than with data. Measured drifting by 7,740 rows within minutes on
this service. Use `uniqExact(minute)` and `sum(delta)`.

**The user table is not a copy.** A user with two concurrent sessions counts as 2 in
`concurrency_deltas` and 1 in `user_concurrency_deltas`. On the frozen slice, peak sessions 2,829
and peak users 2,749, both at 2026-07-26 10:56 `[V:frozen_slice_stability]`.

### `content`

**Holds.** Content metadata, joined in to attach `video_type`.

**Engine.** `SharedReplacingMergeTree`, **`ORDER BY content_id`**. Replacing so a re-load of the
metadata file is idempotent.

| Column | Type | Default |
|---|---|---|
| `content_id` | `Int64` | |
| `title` | `String` | |
| `video_type` | `LowCardinality(String)` | |
| `category` | `LowCardinality(String)` | |
| `ingested_at` | `DateTime` | `now()` |

**Costs.** 33,464 rows, 219.95 KiB, 1 part.

**Watch out.** A `DICTIONARY` with `dictGet` was tried first and abandoned: on Cloud, `dictHas`
returned 0 for keys an `INNER JOIN` matched, because dictionaries load per replica. The join is the
working version, and the header comment in `sql/schema/02_content.sql` records why.

### Validation-only objects

These are not part of the serving path. They exist so that claims can be checked.

**`concurrency_deltas_naive`** (`SharedSummingMergeTree(delta)`, same key and columns as
`concurrency_deltas`, 15,725 rows, 40.25 KiB). The **wrong** answer, built deliberately: concurrency
from raw session span, counting a backgrounded app as watching. It is the baseline that shows what
foreground-only correction is worth `[V:naive_baseline]` `[V:naive_vs_foreground]`. Never read it
from a dashboard query.

**`open_test_sessions`** (`SharedMergeTree ORDER BY video_session_id`, 30 rows: `video_session_id`,
`cutoff UInt32`) and **`open_test_bystanders`** (200 rows, `video_session_id`). The fixture for the
open-session test: sessions still running at a cutoff, plus bystanders that must not move when
those sessions are revised `[V:open_sessions]`.

## The serving surface

```
sql/queries/serving/concurrency_curve.sql        reads concurrency_deltas / user_concurrency_deltas
sql/queries/serving/peak_average.sql             reads concurrency_deltas / user_concurrency_deltas
sql/queries/serving/test_peak_is_not_a_rollup.sql  assertion, not a serving query
```

Parameters are uniform: `platform`, `country`, `video_type`, `app_version` as `String` where `''`
means all, `content_id` as `Int64` where `0` means all, `from_ts` and `to_ts` as the half-open
window, `grain_s` as 60, 3600 or 86400, and `frozen_before` injected by `ch.sh`.

Three properties worth knowing before you read the SQL:

1. **The cumulative sum is seeded by every delta before the window.** A session that opened at
   09:00 and is still watching at 10:30 must count in a 10:00 to 11:00 window and contributes no
   delta inside it. A 1-hour window and a whole-corpus window read the same 26,904 rows, and the
   read budget fails loudly if the analyzer ever starts pushing the time predicate down.
2. **The curve is dense.** Every minute in the range appears whether or not anybody was watching,
   seeded explicitly rather than by `WITH FILL`. This is a correctness requirement: the average
   over sparse rows answers a different question.
3. **Peak is not a rollup.** It is computed after filtering, from the per-minute series for the
   exact tuple requested. An android slice and an android-plus-india slice peak at different
   minutes in the same range. Measured: max per-platform peak 1,743 and sum of per-platform peaks
   2,918, against an overall 2,829, so the overall peak is neither the max nor the sum
   `[V:peak_not_a_rollup]`.

`sql/queries/validation/` holds the slow, obviously-correct brute-force versions the serving layer
is checked against; `sql/queries/benchmark/` holds the graded questions with their measured reads.

## Invariants, checked on every run

`./scripts/ground_state.sh` reports all of these `[V:frozen_slice_stability]`.

| Invariant | Required | Measured | What a breach would mean |
|---|---:|---:|---|
| `closure.session_deltas` | 0 | 0 | a session was counted up and never down |
| `closure.user_deltas` | 0 | 0 | same, user level |
| `runs_inverted` | 0 | 0 | a run ends before it starts |
| `intervals_inverted` | 0 | 0 | an interval ends before it starts |
| `max_runs_per_session_minute` | 1 | 1 | one session counted twice at one instant |
| `serving.min_concurrency` | 0 | 0 | concurrency went negative |

The last two carry the most weight. `max_runs_per_session_minute = 1` is the no-double-count proof.
`min_concurrency = 0` says the deltas balance **in order**, not merely in total: a curve can sum to
zero overall and still go negative in the middle, and that would be a real bug closure alone would
not catch.

## Keeping this file honest

This file is the **physical reference**, regenerated from `system.*`.
[`DATA_MODEL.md`](DATA_MODEL.md) is the reasoning narrative and
[`problem/dataset_details.md`](problem/dataset_details.md) is the source-CSV dictionary. When they
disagree about a number, the live server wins and this file gets corrected.

To re-read every structural fact above, in order:

```bash
./scripts/ch.sh --format PrettyCompact --query "
  SELECT name, engine, total_rows, formatReadableSize(total_bytes)
  FROM system.tables WHERE database = 'phoenix' ORDER BY name"

./scripts/ch.sh --format TSV --query "
  SELECT name, engine_full, sorting_key, partition_key
  FROM system.tables WHERE database = 'phoenix' AND engine LIKE '%MergeTree%' ORDER BY name"

./scripts/ch.sh --format TSV --query "
  SELECT table, name, type, default_expression
  FROM system.columns WHERE database = 'phoenix' ORDER BY table, position"

./scripts/ch.sh --format PrettyCompact --query "
  SELECT table, count() parts, sum(rows) rows,
         formatReadableSize(sum(data_compressed_bytes)) comp,
         formatReadableSize(sum(data_uncompressed_bytes)) uncomp
  FROM system.parts WHERE database = 'phoenix' AND active GROUP BY table ORDER BY table"

./scripts/ch.sh --format TSV --query "
  SELECT name, as_select FROM system.tables
  WHERE database = 'phoenix' AND engine IN ('MaterializedView', 'View')"
```

`./scripts/inventory.sh` runs the equivalent set and writes a timestamped artifact to `evidence/`.
`./scripts/check_docs.sh` enforces that every `[V:<id>]` above resolves to a row in
[`../evidence/LEDGER.tsv`](../evidence/LEDGER.tsv).
