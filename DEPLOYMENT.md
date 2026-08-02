# Deploying to an AWS EC2 Ubuntu instance

For the submission demo: both consoles, the ClickStack observability stack, and the LibreChat agent,
on one box, reachable over a URL a judge can open.

ClickHouse itself is **not** deployed here. It stays on ClickHouse Cloud; this instance is the
application tier and connects out to it. Nothing below creates or moves a database.

## What ends up running

| Process | Port | Public? | What it is |
|---|---|---|---|
| Next.js consoles | 3200 | **yes**, via the proxy | `/` concurrency, `/v2` insights |
| HyperDX (ClickStack) | 8090 | via the proxy, see the warning below | the observability dashboard |
| OTel collector | 4317 / 4318 | **no** | receives spans from `emit_query_spans.sh` |
| LibreChat | 3080 | **no** | the Ask AI agent |
| mcp-clickhouse | 8000 | **no**, never published | the agent's ClickHouse tool |
| Mongo, Meilisearch, RAG, vectordb | internal | **no** | LibreChat's own dependencies |

## Instance

**t3.large or larger, Ubuntu 22.04 or 24.04, 40 GB gp3.** Sizing is set by LibreChat, not by us:
its stack is seven containers including Mongo, Meilisearch and a vector database. The consoles and
the producer scripts are comfortable in well under a gigabyte, because every query runs on Cloud and
every event is generated server-side by `numbers()` rather than shipped over the wire.

Two disk consumers to watch: Docker images (roughly 8 GB once LibreChat and ClickStack are pulled)
and the `live_demo.*.log` files, which a long run grows steadily.

## Security groups

Inbound: **22 from your IP only**, **80 and 443 from anywhere**. Nothing else.

Do not open 3200, 3080, 8090, 4317, 4318 or 8000 to the internet. They are reached through the
reverse proxy, or not at all. `mcp-clickhouse` is deliberately unpublished even on the host: it is
reachable only from the LibreChat container on the compose network, and it holds a ClickHouse
credential.

Outbound: 443, to reach ClickHouse Cloud. If the Cloud service has an IP allow list, add this
instance's elastic IP to it before anything below will work.

## 1. Prerequisites

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git jq python3 nginx
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker ubuntu && newgrp docker

# Node 20. The frontend needs it; the repo pins nothing older.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# clickhouse-client, used by every script in scripts/ through scripts/ch.sh
curl https://clickhouse.com/ | sh && sudo mv ./clickhouse /usr/local/bin/
```

## 2. The repository and its three env files

```bash
git clone git@github.com:DynamiteC/phoenix-concurrency.git
cd phoenix-concurrency
```

Nothing here is in version control, and none of it should be pasted into a file that is.

**`.env`** at the repo root: the ClickHouse Cloud connection every script uses.

```bash
cp .env.example .env
# CH_HOST, CH_USER, CH_PASSWORD from the Cloud console. CH_PORT stays 9440: that is the native
# port for clickhouse-client. Anything speaking HTTPS uses 8443, and the two are not
# interchangeable. frontend/src/lib/env.ts refuses to read CH_PORT for exactly this reason.
./scripts/ch.sh --query "SELECT 1"        # must return 1 before continuing
```

**`frontend/.env.local`**: what the consoles read.

```
CH_DATABASE=phoenix_next
FROZEN_BEFORE=2100-01-01
NEXT_PUBLIC_CLICKSTACK_URL=https://<your-host>/clickstack-ui
LIBRECHAT_URL=http://localhost:3080
LIBRECHAT_API_KEY=
LIBRECHAT_AGENT_ID=
```

`FROZEN_BEFORE` is the boundary every serving query carries as `AND minute < {frozen_before}`. It
exists so a benchmark answer cannot read live rows, and it also hides the live slice, so a demo
that shows ingest arriving needs it in the future. The two LibreChat values stay blank until step 6.

**`librechat/.env`**: gitignored, and the only file that holds the agent's database credential.

```bash
cd librechat && cp .env.example .env
python3 - <<'EOF'
import secrets, re
s = open('.env').read()
for k, v in [('CREDS_KEY', secrets.token_hex(32)), ('CREDS_IV', secrets.token_hex(16)),
             ('JWT_SECRET', secrets.token_hex(32)), ('JWT_REFRESH_SECRET', secrets.token_hex(32)),
             ('MEILI_MASTER_KEY', secrets.token_urlsafe(32)),
             ('MONGO_URI', 'mongodb://mongodb:27017/LibreChat')]:
    s = re.sub(rf"(?m)^{k}=.*$", f"{k}={v}", s, count=1)
open('.env', 'w').write(s)
EOF
```

Generate the secrets, do not copy the ones in `.env.example`: they are published defaults and every
LibreChat install that keeps them shares them.

Then append the ClickHouse block, which must point at the **read-only** user from step 3:

```
CLICKHOUSE_HOST=<the Cloud hostname>
CLICKHOUSE_PORT=8443
CLICKHOUSE_USER=phoenix_ask
CLICKHOUSE_PASSWORD=<from step 3>
CLICKHOUSE_SECURE=true
CLICKHOUSE_VERIFY=true
```

## 3. The read-only credential the agent uses

Run once against Cloud, from anywhere with admin access. This is the control that makes the Ask AI
boundary real rather than advisory, and [`docs/SECURITY_ASK.md`](docs/SECURITY_ASK.md) explains why
the system prompt is not sufficient on its own.

```sql
CREATE USER IF NOT EXISTS phoenix_ask IDENTIFIED BY '<generate one, needs a special character>'
  SETTINGS readonly = 1, max_execution_time = 30, max_result_rows = 100000;
GRANT SELECT ON phoenix.* TO phoenix_ask;
GRANT SELECT ON phoenix_next.* TO phoenix_ask;
```

Verify it before trusting it. All three must hold:

```bash
H=<host>; P='<password>'
curl -s "https://$H:8443/?database=phoenix" -u "phoenix_ask:$P" --data-binary \
  "SELECT count() FROM concurrency_deltas"          # a number
curl -s "https://$H:8443/?database=phoenix" -u "phoenix_ask:$P" --data-binary \
  "CREATE TABLE t (a Int8) ENGINE=Memory"           # Code: 497, Not enough privileges
curl -s "https://$H:8443/?database=phoenix" -u "phoenix_ask:$P" --data-binary \
  "SELECT 1 SETTINGS readonly=0"                    # Code: 164, cannot modify readonly
```

The third is the one that matters: it means the restriction cannot be lifted from inside the
session, so it does not depend on the agent choosing to respect it.

## 4. ClickStack

```bash
cd docker/clickstack && docker compose --env-file ../../.env up -d   # ~60s to healthy
cd ../.. && ./scripts/clickstack_setup.sh                            # idempotent
```

The setup script creates the HyperDX team, a connection to **our** Cloud service rather than the
instance bundled in the image, the source, and five panels. It fails loudly if HyperDX answers from
the bundled ClickHouse instead, which is a failure that otherwise looks exactly like success. See
[`docs/clickstack.md`](docs/clickstack.md).

Then give it something to show. The collector ships only its own metrics until this runs:

```bash
MINUTES=60 LIMIT=2000 ./scripts/emit_query_spans.sh
```

## 5. The consoles

```bash
cd frontend && npm ci && npm run build
```

Run it under systemd so it survives a logout and comes back after a reboot:

```ini
# /etc/systemd/system/phoenix-console.service
[Unit]
Description=Phoenix consoles
After=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/phoenix-concurrency/frontend
Environment=PORT=3200
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now phoenix-console
curl -s localhost:3200/api/status | head -c 120     # counters, not an error
```

## 6. LibreChat

```bash
cd librechat && docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
```

Seven containers; the first pull takes several minutes. `docker ps` should show `LibreChat`,
`mcp-clickhouse`, `chat-mongodb`, `chat-meilisearch`, `rag_api` and `vectordb` up.

**Three steps here are yours, not the script's,** because they involve creating an account and
handling credentials:

1. Open LibreChat and register the first user. It becomes the admin.
2. Create an agent named `Project Assistant`, give it a model provider key, and enable the
   `clickhouse` MCP tool on it. Copy its agent id from the URL.
3. Settings, API Keys, create one. Copy it.

Put both into `frontend/.env.local` as `LIBRECHAT_AGENT_ID` and `LIBRECHAT_API_KEY`, then
`sudo systemctl restart phoenix-console`.

Until they are set, the Ask AI tab returns a message saying exactly that, and every other tab on
both consoles works normally.

Then prove the boundary holds on this host:

```bash
./scripts/check_ask_guardrails.sh
```

## 7. Reverse proxy and TLS

```nginx
# /etc/nginx/sites-available/phoenix
server {
  listen 80;
  server_name <your-host>;

  location / {
    proxy_pass http://127.0.0.1:3200;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;          # the Ask AI round trip can take a minute
  }

  # The observability dashboard. Read the warning below before exposing this.
  location /clickstack-ui/ {
    proxy_pass http://127.0.0.1:8090/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/phoenix /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo snap install --classic certbot && sudo certbot --nginx -d <your-host>
```

TLS is not optional if you expose ClickStack: the auto-login route sets a session cookie, and over
plain HTTP that cookie crosses the network in the clear.

### The ClickStack link publishes an authenticated dashboard

`/clickstack` signs a visitor into HyperDX and redirects. On a laptop that is a convenience. On a
public host it means **anyone who finds the URL gets an authenticated observability session**, with
query history and schema visible.

Decide before the demo:

- **Simplest**: leave the `/clickstack-ui/` location out of the nginx config. The link then fails
  for outside visitors, and you demonstrate ClickStack over your own screen share.
- **Or**: keep it and put HTTP basic auth on that location, sharing the credential with judges.
- **Or**: restrict it by source IP with `allow`/`deny`.

The route derives its cookie domain from the request host, so it works behind a real hostname, and
it sends no `Domain` attribute when the host is a bare IP, because that attribute is only valid for
names. It marks the cookie `Secure` when the request arrived over HTTPS.

## 8. Data

The instance connects to whatever the Cloud service already holds. If it is a fresh service:

```bash
./scripts/load.sh data/ch-hackathon-content-data.csv content phoenix_next   # FIRST. See below.
./scripts/load.sh data/ch-hackathon-raw-data.csv raw_events phoenix_next
FROM_TS='2026-07-01 00:00:00' TO_TS='2026-08-03 00:00:00' \
  CH_DATABASE=phoenix_next ./scripts/refresh_insights.sh
```

`content` first, always. The live producer resolves its stream ids by joining against it and hard
fails if it is empty, and title and category filtering in both consoles resolves the same way, so a
`content_id` with no `content` row is invisible to every filtered query: no error, just a title that
does not exist. [`docs/INGEST_COMMANDS.md`](docs/INGEST_COMMANDS.md) section 0 has the rule and the
orphan check.

For a live demo:

```bash
CYCLES=360 DB=phoenix_next ./scripts/live_demo.sh
```

Run it in `tmux` or `screen`. It is a foreground orchestrator and dies with the SSH session
otherwise.

## 9. Verify before calling it deployed

```bash
curl -s https://<host>/api/status | jq .events           # a growing number
curl -s https://<host>/api/concurrency\?from=...\&to=... # points, peak, sqlFiles, bytesRead
./scripts/check_docs.sh                                  # claims match their evidence
./scripts/check_ask_guardrails.sh                        # the Ask AI boundary holds
```

In a browser: the curve draws on `/`, a platform filter changes it, every one of the eleven tabs on
`/v2` returns rows, and both consoles print the query and its read cost under the answer.

## Operations

```bash
sudo journalctl -u phoenix-console -f          # console logs
docker compose -f librechat/docker-compose.yml logs -f api
docker logs -f phoenix-clickstack
tail -f live_demo.producer.phoenix_next.log    # during a live run
```

Restart everything after a reboot: the Docker stacks carry `restart: unless-stopped` and the console
is a `systemd` unit, so nothing needs starting by hand. The live demo does, because it is a demo
rather than a service.

## Secrets checklist before you push or share the instance

- `git status --short` shows no `.env`, no `.env.local`, no `librechat/.env` and no `.csv`
- `librechat/.env` holds `phoenix_ask`, not the ingest credential
- LibreChat's `CREDS_KEY`, `CREDS_IV`, `JWT_SECRET` and `MEILI_MASTER_KEY` are generated, not the
  published example values
- the HyperDX login is still the documented demo credential, which is fine only because it is a
  demo dashboard, and not fine if you exposed `/clickstack-ui/` without basic auth
