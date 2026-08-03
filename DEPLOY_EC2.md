# Deploy: EC2 Ubuntu, HTTPS at the-phoenix.cricheroes.io

Seven containers, three published ports (80 redirect, 443 site, 3080 LibreChat). ClickHouse is
Cloud, not on the host. Three existing databases are reused: `phoenix_graded` (frozen original
corpus, v1), `phoenix_unseen` (frozen unseen day, v1), `phoenix_live` (live: producer writes,
ticker derives, v2 insights, 48h TTL).

## Prerequisites

- Ubuntu 22.04/24.04, t3.medium or larger (build needs ~2 GB).
- Security group: 80, 443, 3080 from 0.0.0.0/0; 22 from your IP.
- DNS A record: `the-phoenix.cricheroes.io` -> instance IP.
- ClickHouse Cloud credentials; wildcard cert in `ssl_star_dot_io/` (expires 2026-09-12).

## 1. Sync and deploy

```bash
rsync -avz --exclude node_modules --exclude .next \
  /home/shailsheth/hackathon/the-phoenix/ ubuntu@<ec2-ip>:~/the-phoenix/
ssh ubuntu@<ec2-ip>
cd the-phoenix && bash deploy.sh
```

`deploy.sh` installs docker if missing, restores exec bits, builds `deploy/ssl/` from
`ssl_star_dot_io/`, checks `.env` (created from `.env.example` on first run; fill `CH_*` and
re-run), brings up all seven containers, and verifies ports and HTTP codes. `--no-chat` skips
LibreChat. FileZilla (SFTP to `~/the-phoenix`) works instead of rsync.

Key `.env` values: `CH_DATABASE=phoenix_graded`, `CH_UNSEEN_DATABASE=phoenix_unseen`,
`CH_INSIGHT_DATABASE=phoenix_live`, `LIVE_DB=phoenix_live`. Leave `LIBRECHAT_API_KEY` blank and
`ALLOW_SERVER_LLM_KEY=false`: visitors pick a model and paste their own key in the Ask tab, so
questions bill to them, never to this host.

## 2. Prepare the databases (once)

The three databases already exist and keep their data; nothing is rebuilt. One one-time fix on
`phoenix_live` before the producer restarts (this is the fix for the data-limit "query didn't
load" failure that forced stopping it):

```bash
sudo apt-get install -y clickhouse-client

./scripts/apply_live_ttl.sh phoenix_live     # 48h DELETE TTL on raw + derived + insight tables;
                                             # refuses the frozen databases
```

No repartitioning: phoenix_live's tables are already daily-partitioned, which is the ideal
pairing with a 48h TTL (expired days drop as whole parts, no delete mutations).

`phoenix_graded` and `phoenix_unseen` are never written or TTLed. The unseen day's dirty tail
(stray rows 2014 to 2026-08) is handled in the UI (the unseen dataset defaults to its real day,
2026-07-31, with suggested filters); if you ever reload that corpus, filter at insert with
`WHERE event_timestamp >= '2026-07-24' AND event_timestamp < '2026-08-02'`.

## 3. Verify

```bash
docker compose --profile chat ps    # web and ticker must read (healthy)
```

Open `https://the-phoenix.cricheroes.io/`: curve renders, filters populate, dataset switch flips
between corpus and unseen day. Open `/v2` and `https://the-phoenix.cricheroes.io:3080`; ask a question in the v2 Ask tab (with
your own model key) and confirm the trace lands in cloud Langfuse.

## 4. Operate

```bash
docker compose logs -f ticker       # silent on success, full error on failure
docker compose restart web
docker compose --profile chat down  # data lives in ClickHouse Cloud
```

## After cutover: prune unused databases (by hand, never scripted)

`phoenix_graded`, `phoenix_unseen`, and `phoenix_live` stay: they are the deployment. The rest
are leftovers from earlier generations; once the new host is verified live, drop them:

```sql
DROP DATABASE IF EXISTS phoenix;          DROP DATABASE IF EXISTS phoenix_next;
DROP DATABASE IF EXISTS phoenix_live_v2;  DROP DATABASE IF EXISTS phoenix_insights;
DROP DATABASE IF EXISTS phoenix_scratch_rehearsal;
```

## Known limits

- Suffix filters (`video_resolution` etc.) prune weakly; `p_suffix_first` projection recovers most.
- A one-hour window costs the same as whole-corpus by design (cumulative sum from history);
  `MAX_WINDOW_DAYS = 31` bounds it.
- Cert rotation: replace `deploy/ssl/*`, then `docker compose restart proxy`.
