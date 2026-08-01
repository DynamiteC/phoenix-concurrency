# frontend: Phoenix Console

A Next.js (App Router, TypeScript) dashboard for the foreground-only concurrency serving layer.
This replaces `demo/` as the primary UI: same data contract, same ClickHouse HTTP proxy pattern,
rebuilt as a typed, componentized app instead of one HTML file.

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

The SQL is inlined in each route handler (`src/app/api/concurrency/route.ts` and
`src/app/api/user-concurrency/route.ts`), mirroring the pipeline's production queries at
[`sql/queries/benchmark/concurrency.sql`](../sql/queries/benchmark/concurrency.sql) and
[`sql/queries/benchmark/user_concurrency.sql`](../sql/queries/benchmark/user_concurrency.sql)
rather than reading those files off disk, this app has no runtime dependency on the rest of the
repo and can be deployed on its own. If the pipeline's query logic changes, port the change into
both copies.

## Setup

Requires **Node 20+**.

```bash
nvm use 20            # or: nvm install 20
cd frontend
npm install
```

Credentials: this app reads the repo-root `../.env` (the same file `scripts/ch.sh` and
`demo/server.js` use) for `CH_HOST` / `CH_PORT` / `CH_USER` / `CH_PASSWORD` / `CH_DATABASE`.
If it doesn't exist yet:

```bash
cp ../.env.example ../.env    # fill in from the ClickHouse Cloud console
```

`.env.local.example` in this folder documents an optional frontend-only override; you do not
need it if `../.env` is already set up.

## Run

```bash
npm run dev      # http://localhost:3200 (3100 stays free for demo/server.js)
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
