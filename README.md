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

<!-- TODO: diagram. raw events -> foreground-interval derivation -> serving layer -> dashboard -->
_Not decided yet. Options and the reasoning behind the choice go in
[`docs/assumptions.md`](docs/assumptions.md) as they are made, not reconstructed at 3am._

## Layout

```
docs/problem/   problem statement + data dictionary (given, do not edit)
docs/           assumptions.md, the living decision log
sql/schema/     DDL, one file per table
sql/queries/    benchmark and validation queries
scripts/        load.sh (CSV -> ClickHouse), profile.sh (dataset facts)
pitch/          slides and demo notes
data/           gitignored, the CSVs never enter version control
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
