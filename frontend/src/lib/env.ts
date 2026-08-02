// Reuses the repo-root .env (the same file scripts/ch.sh and the retired demo server read) so
// ClickHouse Cloud credentials live in exactly one gitignored place. This module is only ever
// imported by route handlers, which run on the Node.js runtime server-side, the values here
// never reach the browser.
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.join(process.cwd(), '..')
const ENV_FILE = path.join(REPO_ROOT, '.env')

try {
  const contents = fs.readFileSync(ENV_FILE, 'utf8')
  for (const line of contents.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    const key = m?.[1]
    if (key && !process.env[key]) process.env[key] = m?.[2] ?? ''
  }
} catch {
  // No repo-root .env (e.g. CI running only `next build`). Route handlers that need
  // ClickHouse will fail loudly per-request instead of at import time.
}

export const CH_HOST = process.env.CH_HOST || ''

// DELIBERATELY NOT process.env.CH_PORT. The repo-root .env sets CH_PORT=9440, which is the
// NATIVE secure protocol port that clickhouse-client uses. This module feeds an HTTPS fetch,
// and the HTTPS interface is 8443. Reading CH_PORT here meant every request went to 9440 as
// HTTPS and could never succeed, and the `|| 8443` fallback was unreachable because the
// loader above had already populated CH_PORT from ../.env. Override with CH_HTTP_PORT if a
// deployment genuinely differs; CH_PORT is left alone so ch.sh keeps working.
export const CH_PORT = Number(process.env.CH_HTTP_PORT || 8443)

export const CH_USER = process.env.CH_USER || 'default'
export const CH_PASSWORD = process.env.CH_PASSWORD || ''
export const CH_DATABASE = process.env.CH_DATABASE || 'default'

// The isolation boundary, still a parameter on every serving query, but OFF by default.
//
// It used to default to 2026-08-01, which pinned the dashboard to the validated corpus so the
// number on screen equalled the number in evidence/. The cost of that is a console that cannot
// show live ingest: the header counters moved while the curve stayed on a slice that ended days
// earlier. Live is what this app is for, so the default horizon is now far-future, which makes
// `minute < {frozen_before}` a no-op rather than deleting the predicate from the SQL.
//
// Set FROZEN_BEFORE=2026-08-01 in the environment to restore evidence parity for a comparison
// run: the queries are unchanged, so the frozen figures reproduce exactly.
export const FROZEN_BEFORE = process.env.FROZEN_BEFORE || '2100-01-01'

// LibreChat's OpenAI-compatible remote-agent endpoint (see /api/ask). LIBRECHAT_API_KEY and
// LIBRECHAT_AGENT_ID are blank until the user creates a key in the LibreChat UI (Settings ->
// API Keys) and copies the Project Assistant agent's id — /api/ask fails loudly per-request
// until both are set, same pattern as CH_HOST above.
export const LIBRECHAT_URL = process.env.LIBRECHAT_URL || 'http://localhost:3080'
export const LIBRECHAT_API_KEY = process.env.LIBRECHAT_API_KEY || ''
export const LIBRECHAT_AGENT_ID = process.env.LIBRECHAT_AGENT_ID || ''
