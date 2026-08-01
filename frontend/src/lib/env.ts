// Reuses the repo-root .env (the same file scripts/ch.sh and demo/server.js read) so
// ClickHouse Cloud credentials live in exactly one gitignored place. This module is only ever
// imported by route handlers, which run on the Node.js runtime server-side — the values here
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
export const CH_PORT = Number(process.env.CH_PORT || 8443)
export const CH_USER = process.env.CH_USER || 'default'
export const CH_PASSWORD = process.env.CH_PASSWORD || ''
export const CH_DATABASE = process.env.CH_DATABASE || 'default'
