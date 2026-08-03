# Next steps

Everything in the repo is done and verified (build, guardrails, port checks, compose). What
remains is operational, in order:

## 1. Credentials check (done)

- [x] Test key from `AskAI.tsx` deleted (no billing was enabled); `GOOGLE_KEY` blanked.
- [x] LibreChat clean slate: `CREDS_KEY`, `CREDS_IV`, `JWT_SECRET`, `JWT_REFRESH_SECRET`
      regenerated; meilisearch/admin-panel secrets blanked; Mongo data, uploads, logs, and the
      old Mongo backup wiped. Every existing chat account and conversation is gone: the first
      person to register on the new install creates a fresh account. Langfuse cloud keys kept.
- [x] `.env` `LIBRECHAT_API_KEY` is blank and `ALLOW_SERVER_LLM_KEY=false`. Keep them that way:
      visitors bring their own model key in the Ask tab.

## 2. One-time ClickHouse prep (before the producer restarts)

```bash
./scripts/apply_live_ttl.sh phoenix_live   # 48h DELETE TTL; the actual fix for the
                                           # "query didn't load" data-limit failure
```

No repartitioning needed: phoenix_live's tables are already daily-partitioned (verified via
system.tables), which is the ideal pairing with a 48h TTL since expired days drop as whole
parts instead of running delete mutations.

`phoenix_graded` and `phoenix_unseen` are frozen; the TTL script refuses them by name.

## 3. Deploy the new EC2

- Security group: 80, 443, 3080 from 0.0.0.0/0; 22 from your IP.
- Sync and run (FileZilla to `~/the-phoenix` works too):

```bash
rsync -avz --exclude node_modules --exclude .next \
  /home/shailsheth/hackathon/the-phoenix/ ubuntu@<ec2-ip>:~/the-phoenix/
ssh ubuntu@<ec2-ip> 'cd the-phoenix && bash deploy.sh'
```

`deploy.sh` installs docker if missing, builds the TLS certs from `ssl_star_dot_io/`, checks
`.env` (fill `CH_*` on first run), starts all 7 containers, and verifies ports and HTTP codes.

- Point the DNS A record `the-phoenix.cricheroes.io` at the new instance IP.

## 4. Verify live

- `https://the-phoenix.cricheroes.io/` : curve renders, dataset switch flips original/unseen,
  unseen defaults to 2026-07-31 with suggested filter chips.
- `/v2` : all ten views return data once producer + ticker have run ~10 minutes;
  `docker compose --profile chat ps` shows web and ticker healthy.
- `https://the-phoenix.cricheroes.io:3080` : LibreChat loads (TLS via the proxy; `/chat/` now just
  redirects here); ask a question in the v2 Ask tab with your own key; trace appears in cloud
  Langfuse; an off-topic prompt gets refused without reaching the model.
- Producer first run: `docker compose logs producer` after ~2 minutes; each cycle should print an
  insert summary with no SQL errors (the spike/error/lateness/handoff branches are new).
- REQUIRED once, or the Ask tab is dead: the LibreChat wipe deleted the agent that
  `LIBRECHAT_AGENT_ID` in `.env` points to. Registration is disabled (`ALLOW_REGISTRATION=false`,
  end users never register), so create the one admin account via CLI, then recreate the agent:

  ```bash
  docker compose exec api npm run create-user   # prompts for email/name/password
  ```

  Log in at `https://the-phoenix.cricheroes.io:3080`, create the Project Assistant agent (with the
  clickhouse MCP tool enabled), copy its agent id into `LIBRECHAT_AGENT_ID` in the repo-root
  `.env`, then `docker compose restart web`.

## 5. After cutover is verified (hand-run, never scripted)

Drop the leftover databases; the three working ones stay:

```sql
DROP DATABASE IF EXISTS phoenix;          DROP DATABASE IF EXISTS phoenix_next;
DROP DATABASE IF EXISTS phoenix_live_v2;  DROP DATABASE IF EXISTS phoenix_insights;
DROP DATABASE IF EXISTS phoenix_scratch_rehearsal;
```

Then decommission the old EC2 instance.

## Reference

- Full runbook: `DEPLOY_EC2.md`
- New-developer guide: `ONBOARDING.md`; architecture walkthrough: `.tours/phoenix-architecture.tour`
- Cert expires 2026-09-12: replace `deploy/ssl/*`, then `docker compose restart proxy`
