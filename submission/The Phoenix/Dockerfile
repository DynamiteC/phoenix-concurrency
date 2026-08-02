# The console image. Also the base for the ingest and derive workers, because they need the same
# thing the app needs: the repo's sql/ and scripts/ trees plus the clickhouse client.
#
# ONE IMAGE, THREE ROLES. web, producer and ticker differ only in their command. A separate
# slimmer image per worker would save a few hundred MB and cost a second Dockerfile to keep in
# step with this one, which is the trade this project has already lost once elsewhere.
FROM node:20-bookworm-slim

# ca-certificates for the HTTPS connection to ClickHouse Cloud, curl to fetch the client,
# flock (util-linux) because derive_tick.sh serialises ticks on a lock file.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl util-linux tzdata \
 && rm -rf /var/lib/apt/lists/*

# The same binary scripts/ch.sh expects on PATH. Pinned rather than `curl | sh` so a rebuild
# during judging cannot pick up a different client than the one the numbers were measured with.
ARG CLICKHOUSE_VERSION=25.3.1.2703
RUN curl -sSL "https://github.com/ClickHouse/ClickHouse/releases/download/v${CLICKHOUSE_VERSION}-lts/clickhouse-common-static-${CLICKHOUSE_VERSION}-amd64.tgz" \
      -o /tmp/ch.tgz \
 && tar -xzf /tmp/ch.tgz -C /tmp \
 && /tmp/clickhouse-common-static-${CLICKHOUSE_VERSION}/install/doinst.sh \
 && rm -rf /tmp/ch.tgz /tmp/clickhouse-common-static-${CLICKHOUSE_VERSION} \
 && clickhouse client --version

WORKDIR /app

# Dependencies first, so a source edit does not reinstall node_modules.
COPY frontend/package.json frontend/package-lock.json* frontend/
RUN cd frontend && npm ci

COPY . .

RUN cd frontend && npm run build

# THE APP READS THE REPO AT RUNTIME, which is why the whole tree is copied rather than just the
# build output. lib/sql.ts reads ../sql/queries/serving/*.sql and lib/insights.ts reads
# ../sql/insights/benchmark/*.sql on every request, and lib/env.ts reads ../.env. That is
# deliberate: it is what makes the query text on screen provably the text that executed. A
# standalone Next.js output would 500 on every route.
ENV NODE_ENV=production
ENV PORT=3200
WORKDIR /app/frontend
EXPOSE 3200
CMD ["npm", "run", "start"]
