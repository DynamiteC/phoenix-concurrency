# phoenix-concurrency

**Team: The Phoenix** · ClickHouse Click-a-thon 2026 · SonyLIV track

## The problem

Design a scalable concurrency computation model on top of one or more aggregated tables
(session-aware or session-independent) that uses session start/end along with heartbeat or
active-state signals to count only **truly active** playback intervals, excluding backgrounded
periods, while remaining query-efficient and update-friendly at very large scale.

Counting overlapping sessions overstates the audience: a session can be open while the app is
backgrounded, the player is paused, or the heartbeat has stopped arriving. The unit of truth is
the active interval inside the session, not the session.

Constraints that shape every decision:

- **ClickHouse is the primary datastore and engine.** Ingestion, modelling, and all concurrency
  computation live there.
- **Peak is per dimension combination.** A platform slice and a platform+country slice peak at
  different minutes inside the same range.
- **Update-friendly.** Open sessions keep growing as heartbeats land, and late events arrive
  after the fact. Absorbing them must be incremental, never a rebuild.
- **Must meaningfully integrate one of** ClickStack, Langfuse, or LibreChat.
- **The unseen day.** A fresh day of data drops in the final hours. Reloading is one command
  (`./scripts/load.sh <file> <table>`), not an improvised pipeline at hour 22.

Full statement: [`docs/problem/PROBLEM_STATEMENT.md`](docs/problem/PROBLEM_STATEMENT.md).
Data dictionary: [`docs/problem/dataset_details.md`](docs/problem/dataset_details.md).
Submission rules: [`docs/problem/SONYLIV_SUBMISSION_GUIDELINES.md`](docs/problem/SONYLIV_SUBMISSION_GUIDELINES.md).

## What we solved

| The question | What answers it | The result |
|---|---|---|
| What is an active interval when the heartbeat is missing, the player is paused, or the app is backgrounded? | A three-bucket state machine, unknown values neutral, 90s gap tolerance: `sql/schema/03_event_state.sql` | Naive session-span counting reports **9,942** concurrent where foreground-only counting reports **7,576**: a **31% overcount** removed |
| How should active ranges be represented? | Normalized intervals, to per-session minute runs, to `+1`/`-1` minute deltas | 232 MB of CSV becomes a **61 KiB** serving table; a three-hour session costs the same two rows as a two-minute one |
| How do you get minute-wise peak and average without scanning raw session history? | A seeded cumulative sum over the delta table: `sql/queries/serving/concurrency_curve.sql`, `peak_average.sql` | Peak and average are derived per request, never pre-stored per rollup, because a platform slice and a platform+country slice peak at different minutes |
| How does it stay filter-friendly? | The same queries, parameterised on all six dimensions, pruning granules on the serving table's own sort key | A platform filter prunes to **16,384 rows, 2 of 4 granules** |
| How are open sessions handled? | Retract-and-re-assert on a CollapsingMergeTree, plus an explicit open-session view | Absorbing new heartbeats is incremental. A rebuild is never needed, and what is still revisable is stated on screen rather than hidden |
| Does it hold on data nobody tuned on? | One command reloads a fresh day: `./scripts/load.sh <file> <table>` | [`docs/RUNBOOK_UNSEEN_DAY.md`](docs/RUNBOOK_UNSEEN_DAY.md) |

**Beyond the ask.** A second generation, `phoenix_next`, turns the curve into an explanation:
ten insight views covering why concurrency moved, whether the audience it gained stayed, which
app version loses viewers, which content takes whose audience, which device hands off to which,
and what arrived late enough to change an answer already given. Each is one purpose-built table
and one committed query, gated on parity against ground truth and on what it reads.

**The OSS integration is ClickStack**, not a badge: HyperDX and the OpenTelemetry collector
running against our own ClickHouse Cloud service, with a live dashboard on `concurrency_deltas`
and a read-budget panel built from `system.query_log`. Both consoles link to it.
[`docs/clickstack.md`](docs/clickstack.md).

**Nothing here is quoted from memory.** Every number above resolves through
[`evidence/LEDGER.tsv`](evidence/LEDGER.tsv) to the command that produced it and the artifact it
wrote. `./scripts/check_docs.sh` fails the build when a claim and its evidence disagree.

## The product

Two consoles, one design system, both reading ClickHouse directly.

| Route | Reads | What it is for |
|---|---|---|
| `/` | `phoenix` | The concurrency curve: sessions and users, peak, both averages, p95, reach, open sessions, and the naive-versus-corrected divergence |
| `/v2` | `phoenix_next` | Ten insight views over the audience-intelligence layer |

Both print the ClickHouse query that produced what is on screen, with the table it read, rows
read, bytes read, server time and wall time underneath. The guidelines ask for the query
alongside the curve because the modelling is what is being judged; the text shown is read from
the shipped `.sql` file at request time, so it cannot drift from what executed.

## Architecture

Events become foreground intervals, intervals merge into per-session minute runs, runs emit
`+1` / `-1` deltas, and a cumulative sum over the deltas is the concurrency curve. Cost tracks
interval boundaries rather than watch time, so a three-hour session costs the same two rows as
a two-minute one, and 232 MB of CSV becomes a **61 KiB** serving table.

```mermaid
flowchart LR
    CSV["CSV<br/>905,558 events"] --> LAND["raw_events_landing<br/>ENGINE = Null"]
    LAND -->|MV| RAW[("raw_events<br/>4.12 MiB")]
    RAW --> ST{{"event_state<br/>3-bucket state machine<br/>unknown = neutral"}}
    ST --> FI[("foreground_intervals<br/>599,137")]
    FI --> SMR[("session_minute_runs<br/>17,604 asserted<br/>Collapsing")]
    ST -.->|incremental:<br/>retract + re-assert| SMR
    SMR -->|MV| CD[("concurrency_deltas<br/>61 KiB")]
    SMR --> UMR[("user_minute_runs")] -->|MV| UCD[("user_concurrency_deltas")]
    CD --> Q["serving queries<br/>seeded cumulative sum<br/>peak + both averages"]
    UCD --> Q
    Q --> D["dashboard"]
```

Full reasoning, with the measured cost of every choice, in
[`docs/problem/DESIGN.md`](docs/problem/DESIGN.md). Table-by-table detail in
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

### Filters, and the dataset column behind each

The submission guidelines ask which dataset columns back the filters. Every one of these is carried
into the serving table itself, so filtering prunes granules rather than post-filtering a result.

| Filter in the UI | Dataset column | Where it lives at serving time | Applies to |
|---|---|---|---|
| Platform | `platform` (raw event) | `concurrency_deltas`, `user_concurrency_deltas`, `audience_minute_snapshot` | curve, peak/average, all v2 views whose table carries it |
| Country | `country` (raw event) | same | same |
| Video type | `video_type` (content metadata) | same, denormalised at derive time | same |
| App version | `app_version` (raw event) | same | same |
| Content | `title` -> `content_id` (content metadata) | `content` resolves the title, `content_id` prunes the delta table | same |
| Time window + grain | `event_timestamp` (raw event) | `minute` in every serving table | curve, peak/average, every v2 view |

Content is filtered **by title, never by id**: thousands of content ids reach the serving layer and
nobody filtering a dashboard knows which eight-digit number is which show. The title is resolved
against `content` (`sql/schema/02_content.sql`), which is why a new `content_id` needs a `content`
row before its events arrive: see [`docs/INGEST_COMMANDS.md`](docs/INGEST_COMMANDS.md) section 0.

Two documented dataset dimensions are deliberately **not** exposed. `subtitle_language` is carried
in `raw_events` but not denormalised into the serving tables, and `category` is in `content` but is
not a concurrency dimension anyone asked a question about. Adding either means a column on the
delta tables and a re-derive, not a UI change.

Not every v2 insight table carries every dimension: `concurrency_spike_events` is aggregated per
spike, and `late_event_audit` carries the event and its timing rather than the session's dimensions
(joining back for them would put `raw_events` in the plan, which the read-budget gate forbids). The
v2 console disables the controls a view cannot honour and names the table that lacks the column,
rather than accepting a filter and quietly dropping it. `docs/SUBMISSION_COMPLIANCE.md` has the
per-view matrix.

### The queries behind the curve

Included per the guidelines, since the modelling is the thing being judged rather than the chart:
[`sql/queries/serving/concurrency_curve.sql`](sql/queries/serving/concurrency_curve.sql) (sessions),
[`user_concurrency_curve.sql`](sql/queries/serving/user_concurrency_curve.sql) (distinct users), and
[`peak_average.sql`](sql/queries/serving/peak_average.sql) (peak plus both averages, at any grain).
Both consoles print the file they ran, the table it read and its row count under every answer.

### Proven numbers

Each links to a command and an artifact via [`evidence/LEDGER.tsv`](evidence/LEDGER.tsv).
Nothing here is quoted from memory.

| Claim | Number | Reproduce |
|---|---|---|
| Peak concurrent sessions | **2,828** at 2026-07-26 10:56 | `./scripts/ground_state.sh` |
| Average concurrency, all 1,440 minutes of that day | **88.06** | `./scripts/bench.sh` |
| Average concurrency, the 634 minutes with an audience | **200.00** | `./scripts/bench.sh` |
| Naive session-span counting overstates peak by | **32.3 percent** | `./scripts/naive_baseline.sh` |
| Minutes where naive invents an audience | 1,592 | `./scripts/naive_baseline.sh` |
| Serving vs brute-force oracle | **3,663** minutes, **0 diffs**, both paths | `./scripts/parity.sh` |
| Open sessions absorbed incrementally | 5,316 minutes, **0 diffs** | `./scripts/test_open_sessions.sh 30` |
| Intervals extending past their session's last end | **0**, was 385 | `./scripts/rebuild_swap.sh` |
| Full rebuild run twice, derived tables diffed | **0 diff lines**, 5 of 5 tables | `./scripts/prove_idempotence.sh` |
| Frozen slice stable under concurrent writes | 34 metrics, **0 differing lines**, 2,528 rows ingested between runs | `./scripts/frozen_gate.sh 120` |
| Worst-shape query reads | 30,662 rows in 12 ms, budget 80,712 | `./scripts/bench.sh` |
| Platform filter prunes to | 16,384 rows, 2/4 granules | `./scripts/bench.sh` |
| Full rebuild, CSV to verified serving layer | **70 seconds** | `./scripts/rehearse_runbook.sh` |
| Data-quality invariants | 6 of 6 at required value | `./scripts/ground_state.sh` |

Peak was 2,829 and the average 88.20 until the end-bound fix (decision D8) removed 385 intervals
that ran past their session's last `VideoSessionEnd`. Every restated figure is listed in
[`docs/corrections.md`](docs/corrections.md).

## Documentation

| Start here | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | **Open this first.** Done, in flight, not started, owners |
| [`docs/GROUND_STATE.md`](docs/GROUND_STATE.md) | What is actually on the server, measured |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Every table: purpose, key, cost, invariants |
| [`docs/database_details.md`](docs/database_details.md) | The data dictionary: every database, table, column, and which one answers which question |
| [`docs/CLICKHOUSE_RULES_AUDIT.md`](docs/CLICKHOUSE_RULES_AUDIT.md) | The concurrency schema against the 31 ClickHouse best-practice rules |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every modelling decision, its options, and what each cost |
| [`docs/problem/DESIGN.md`](docs/problem/DESIGN.md) | Trade-offs, the filter-shape read table, the invariant audit |
| [`docs/clickstack.md`](docs/clickstack.md) | The ClickStack integration, and how to rebuild it from nothing |
| [`docs/corrections.md`](docs/corrections.md) | Numbers we published wrong, and what caught them |
| [`docs/RUNBOOK_UNSEEN_DAY.md`](docs/RUNBOOK_UNSEEN_DAY.md) | Exact steps for the sealed drop, rehearsed |
| [`evidence/LEDGER.tsv`](evidence/LEDGER.tsv) | Any claim to the command that produced it, in one hop |
| [`docs/issues/`](docs/issues/) | Findings on ingest, which is a teammate's and untouched |

## Layout

```
docs/problem/       problem statement + data dictionary (given, do not edit)
docs/               STATUS.md first, then DECISIONS.md and corrections.md
sql/schema/         DDL, one file per table
sql/queries/serving/     the ONLY home for shipped query text
sql/queries/validation/  oracle and data-quality queries
sql/queries/known-wrong/ superseded queries, kept as regression fixtures
docker/clickstack/  ClickStack compose file, see docs/clickstack.md
scripts/            load.sh (CSV -> ClickHouse), profile.sh (dataset facts)
frontend/           Next.js (App Router, TypeScript) dashboard, see frontend/README.md
pitch/              slides and demo notes
data/               gitignored, the CSVs never enter version control
```

## Getting started

```bash
cp .env.example .env      # fill in from the ClickHouse Cloud console
cp /path/to/*.csv data/
./scripts/profile.sh data/ch-hackathon-raw-data.csv    # columns, row count, event types, span
./scripts/load.sh data/ch-hackathon-raw-data.csv raw_events
git status --short        # must never show a .csv
```

Needs the `clickhouse` binary on PATH (`curl https://clickhouse.com/ | sh`). Nothing else.

## The service

ClickHouse Cloud, `ap-south-1`, database `phoenix`. Credentials live in `.env`, never in git.

```bash
./scripts/init_db.sh                                        # database + every DDL in sql/schema
./scripts/load.sh data/ch-hackathon-content-data.csv content
./scripts/load.sh data/ch-hackathon-raw-data.csv raw_events_landing
./scripts/ch.sh --query "SELECT count() FROM raw_events"    # ad-hoc queries, UTC pinned
```

Loaded: 905,558 events over 10,866 sessions and 9,618 users, 2026-07-14 15:43 to
2026-07-26 11:30 UTC, plus 33,464 content rows. 232 MB of CSV compresses to 3.76 MiB on disk.
