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
| [`docs/database_details.md`](docs/database_details.md) | Physical reference, plus the ClickHouse best-practice audit |
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
