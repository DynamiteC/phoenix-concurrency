# Phoenix Onboarding Guide

## What Is Phoenix

Phoenix is a real-time concurrency and streaming analytics console for a live Sony LIV dataset. It demonstrates how raw events (session opens, playback, background, close) drive a derived insight layer to visualize concurrent viewership, retention, playback health, and audience trends. Two consoles: v1 (the original corpus) and v2 (live 48h window with freshly derived insights).

## Architecture Map

Five Docker services orchestrate the pipeline:
- **proxy**: nginx (80 > 443 redirect, TLS, load balancing)
- **web**: Next.js serving v1 at / and v2 at /v2
- **producer**: (scripts/live_producer.sh) generates 15 Sony LIV streams, ~12k concurrent sessions
- **ticker**: (scripts/derive_tick.sh) incremental derivation every few minutes, keeps v2 live
- **chat**: (optional, --profile chat) LibreChat API for the Ask tab

Two ClickHouse Cloud databases:
- **phoenix_graded**: frozen original corpus (normal table names) plus frozen unseen day (unseen_ prefix)
- **phoenix_live**: live 48h window, producer writes raw events, ticker derives insights, TTL deletes old rows

Data flow: producer -> raw_events -> ticker (incremental derive) -> 10 insight tables -> v1/v2 API routes -> consoles

## Key Entry Points

Frontend structure:
- `docker-compose.yml` (services, volumes, environment)
- `deploy/nginx.conf` (routing, TLS, /chat/ lazy resolution)
- `frontend/src/app/page.tsx` (v1 console)
- `frontend/src/app/v2/page.tsx` (v2 insight console)
- `frontend/src/app/api/concurrency/route.ts` (example API endpoint)

Dataset switching and SQL loading:
- `frontend/src/lib/datasets.ts` (dataset id validation)
- `frontend/src/lib/datasets.server.ts` (dataset to database/prefix mapping)
- `frontend/src/lib/physicalTableNames.ts` (TABLE_PREFIX rewrite mechanism)
- `frontend/src/lib/sql.ts` (SQL loader, applies prefix)

Ask tab (LLM guardrails):
- `frontend/src/lib/ask.ts` (validateAskPrompt, injection detection)

SQL structure:
- `sql/schema/` (v1 concurrency engine tables and views)
- `sql/insights/schema/` (v2 insight layer)
- `sql/queries/serving/` (all shipped queries, read at request time)
- `sql/insights/benchmark/` (v2 view definitions)

Scripts:
- `scripts/live_producer.sh` (heartbeat loop, 15 streams, 90s state window)
- `scripts/derive_tick.sh` (incremental derivation, flock-guarded watermark)
- `scripts/apply_live_ttl.sh` (48h DELETE TTL, frozen-corpus guard)

Deployment:
- `DEPLOY_EC2.md` (Ubuntu, docker-compose, HTTPS, no local ClickHouse)

## Conventions Worth Knowing

**SQL and Database Names:**
SQL lives in sql/ and is loaded at runtime by src/lib/sql.ts, not embedded in route handlers. Never hardcode a database name in the frontend. The client sends an opaque dataset id ('original' or 'unseen'), and src/lib/datasets.server.ts maps it to a concrete database. A client that could name a database could read any database the service can reach.

**TABLE_PREFIX Mechanism:**
The unseen day lives in phoenix_graded alongside the original corpus, using an unseen_ table prefix to avoid collisions. Physical table names are centralized in src/lib/physicalTableNames.ts. When a dataset uses a prefix, src/lib/sql.ts rewrites every table name in the query text before execution. This allows one SQL file to serve both datasets without duplication.

**Bound Parameters:**
Every filter (platform, country, video_type, app_version, content_id, time window) is bound via ClickHouse bind parameters. The serving queries never construct SQL from request values. Filter parsing lives in src/lib/filters.ts.

**The 90-Second Rule:**
Sessions without an event for 90 seconds stop being concurrent (live_producer.sh enforces this). The producer heartbeats the entire alive population every 30 seconds to hold the curve. Do not lengthen PERIOD without reseeding the state and expectations.

**Incremental Derivation:**
derive_tick.sh runs a retract-then-assert loop over a sliding window. The watermark file (.derive_watermark.<db>) tracks progress. Overlap re-derives sessions near the boundary; it is idempotent by design, not by luck.

## How to Run It

**Local with core services (producer, ticker, consoles):**

```bash
docker compose --profile chat up -d --build
# Consoles at https://localhost/
# LibreChat at https://localhost/chat/ (if --profile chat is used)
```

**Local without LibreChat (faster):**

```bash
docker compose up -d --build
# Consoles at https://localhost/
# /chat/ returns 502 (service down, but everything else works)
```

**Deploy on EC2:**

See DEPLOY_EC2.md. Prerequisites: Docker, .env file with ClickHouse credentials, SSL certs. The playbook handles docker-compose bring-up, port forwarding, and HTTPS at the-phoenix.cricheroes.io.

**Environment:**

Copy .env.example to .env and fill in ClickHouse Cloud credentials (CH_HOST, CH_USER, CH_PASSWORD, CH_DATABASE, CH_INSIGHT_DATABASE).

**Stopping:**

```bash
docker compose down
```
