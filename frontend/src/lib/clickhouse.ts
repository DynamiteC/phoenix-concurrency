// Talks to the ClickHouse HTTP interface directly, the same contract demo/server.js uses:
// POST the fixed SQL text, pass all user-controlled values as `param_*` query-string
// parameters (never string-built into the SQL), read back JSONCompact. SQL text lives inline
// in each route handler (see src/app/api/*/route.ts), self-contained, no read from ../sql.
import {CH_HOST, CH_PORT, CH_USER, CH_PASSWORD, CH_DATABASE} from './env'

interface JSONCompactResult {
  meta: { name: string; type: string }[]
  data: unknown[][]
  statistics?: { rows_read?: number; elapsed?: number }
}

export async function chQuery<P extends object>(sql: string, params: P = {} as P): Promise<JSONCompactResult> {
  if (!CH_HOST) {
    throw new Error('CH_HOST is not set, copy .env.example to ../.env and fill in ClickHouse Cloud credentials')
  }
  const qs = new URLSearchParams({
    database: CH_DATABASE,
    session_timezone: 'UTC',
    default_format: 'JSONCompact',
  })
  for (const [k, v] of Object.entries(params)) qs.append(`param_${k}`, String(v as string | number))

  const res = await fetch(`https://${CH_HOST}:${CH_PORT}/?${qs}`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': CH_USER,
      'X-ClickHouse-Key': CH_PASSWORD,
    },
    body: sql,
    cache: 'no-store',
  })

  const body = await res.text()
  if (!res.ok) throw new Error(body.slice(0, 500))
  try {
    return JSON.parse(body) as JSONCompactResult
  } catch {
    throw new Error(`ClickHouse returned non-JSON: ${body.slice(0, 200)}`)
  }
}
