# frontend: Phoenix Console

A Next.js (App Router, TypeScript) dashboard for the foreground-only concurrency serving layer.
This is the primary and only UI. It replaced a single-file vanilla dashboard, which has been
removed, and it is what a judge sees.

## Problem

Concurrency looks like interval overlap, count sessions whose `[start, end]` span a minute, but
an open session isn't the same as an active one. A session can sit backgrounded, paused, or silent
between heartbeats while still technically "open"; counting that time overstates the audience, and
every downstream decision a dashboard like this drives (ad loads, capacity, content ops) inherits
that overstatement. The actual problem this app's data is built to solve is narrower and harder:
find the truly active sub-ranges inside each session, not the session's full open/close span, and
run concurrency over only those, at a scale where the two obvious approaches both fail. Exploding
every session into one row per minute it was open is too much data to store and scan. Recomputing
overlap from raw session history on every dashboard query is too slow to serve. And sessions aren't
closed books, heartbeats keep arriving on open sessions, so the active ranges have to absorb
updates incrementally rather than being rebuilt from scratch each time.

That's what the pipeline behind `concurrency_deltas` / `user_concurrency_deltas` does upstream of
this app: a per-session state machine turns raw heartbeats into active-range runs (with retraction
when a session that looked paused turns out to still be live), those runs collapse into small
per-minute delta rows, and this dashboard just sums a cumulative window over that delta table, the
hard part (active-range detection under constant updates) is already paid for by the time a query
here runs in single-digit milliseconds.

## What it shows

- **Sessions**: session-aware concurrency, reading `concurrency_deltas`.
- **Users**: session-independent concurrency, reading `user_concurrency_deltas`.
- **Compare**: both curves overlaid, plus the peak-to-peak divergence (one viewer open on two
  devices is two sessions and one user, that gap is the point of having both models, not an
  error in either).

The SQL is **not** in this app. Every shipped query is read off disk from
[`sql/queries/serving/`](../sql/queries/serving/), which is the single source of truth, via
`src/lib/sql.ts`.

This used to be the other way round: the routes inlined their own copy, justified as "no runtime
dependency on the rest of the repo, deployable on its own". What that cost, measured: the inlined
copies were forked from a since-retired benchmark directory whose query this repo had already
measured at **185.95** against a true **88.20** over the same day, and the correction committed to
`serving/` was never ported across. The dashboard served a number 2.1x too high while the correct
query sat in the repo with no reader.

So the trade is now explicit and deliberate: this app requires the repo checkout at runtime,
exactly as it already required `../.env`. In exchange there is no second copy of a query to go
stale, and [`scripts/check_query_sources.sh`](../scripts/check_query_sources.sh) fails the build
if one reappears.

Columns are read from the result **by name**, never by position, so a column added for the
benchmark or validation harness cannot silently shift which number appears under which label.

## Setup

Requires **Node 20+**.

```bash
nvm use 20            # or: nvm install 20
cd frontend
npm install
```

Credentials: this app reads the repo-root `../.env` (the same file `scripts/ch.sh` uses) for
`CH_HOST` / `CH_USER` / `CH_PASSWORD` / `CH_DATABASE`.

It deliberately does **not** read `CH_PORT`. That variable is `9440`, the native secure protocol
port for `clickhouse-client`; this app speaks HTTPS, which is `8443`. Reading it meant every
request went to the wrong port and none could succeed. Override with `CH_HTTP_PORT` if a
deployment genuinely differs.
If it doesn't exist yet:

```bash
cp ../.env.example ../.env    # fill in from the ClickHouse Cloud console
```

`.env.local.example` in this folder documents an optional frontend-only override; you do not
need it if `../.env` is already set up.

## Run

```bash
npm run dev      # http://localhost:3200
npm run build && npm run start   # production build
npm run typecheck
```

## Routes

| Route | Reads | Returns |
|---|---|---|
| `GET /api/concurrency` | `concurrency_deltas` | minute curve + peak/avg, session-aware |
| `GET /api/user-concurrency` | `user_concurrency_deltas` | minute curve + peak/avg, session-independent |
| `GET /api/status` | `raw_events`, `*_minute_runs`, `*_deltas` | ingestion counters, for the live/ingested header |
| `GET /api/dimensions` | `concurrency_deltas` | distinct filter values for the sidebar |

Query params on `/api/concurrency` and `/api/user-concurrency` (all optional):
`platform`, `country`, `video_type`, `app_version`, `content_id`, `from`, `to`.
Empty string / `0` means "no filter on that dimension", filters are always passed as
ClickHouse query parameters (`param_*`), never interpolated into the SQL text.

## Layout

```
src/app/                 App Router pages + route handlers (Node.js runtime, server-only)
src/app/api/*/route.ts   one handler per endpoint above
src/components/          client components, Dashboard orchestrates fetch/state,
                          everything else is presentational
src/lib/                 env loading, the ClickHouse HTTP client, shared types, filter parsing
```

## Design

Dark, data-dense "control room" console rather than a generic admin-panel look: near-black
chassis, phosphor-amber live indicator, signal-orange for the sessions series, cool cyan for the
users series, corner-tick panel framing. One typeface throughout, tabular monospace (IBM Plex
Mono), with headlines built from weight, letter-spacing, and size rather than a second display
family. The chart is a hand-rolled SVG component (no charting dependency) since the data is one
densified per-minute series, a library buys nothing here but bundle size.
