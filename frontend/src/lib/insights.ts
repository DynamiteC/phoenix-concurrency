// The v2 insight console's data access: which database it reads, where its query text lives, and
// the one filter contract every insight query takes.
//
// SEPARATE FROM lib/sql.ts ON PURPOSE, mirroring the split scripts/init_insights.sh already makes
// between sql/schema/ and sql/insights/schema/. The concurrency engine and the insight layer have
// different lifecycles and different blast radii: v1 must keep serving `phoenix` unchanged no
// matter what happens here, and a shared loader would make one directory's failure the other's.
import fs from 'node:fs'
import path from 'node:path'
import {chQuery} from './clickhouse'
import {FROZEN_BEFORE} from './env'
import type {Filters} from './types'

/** The insight layer lives only here. `phoenix` has none of these tables. */
export const INSIGHT_DATABASE = process.env.CH_INSIGHT_DATABASE || 'phoenix_next'

const INSIGHT_DIR = path.join(process.cwd(), '..', 'sql', 'insights', 'benchmark')

// Read once per file per process, the same contract as lib/sql.ts: a changed .sql file is picked
// up by a restart rather than mid-session, so the numbers on screen cannot change without the
// process that reported them changing too.
const cache = new Map<string, string>()

/** Reads a query from sql/insights/benchmark/ by filename, e.g. insightSql('state_flow.sql'). */
export function insightSql(name: string): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = fs.readFileSync(path.join(INSIGHT_DIR, name), 'utf8')
  } catch (cause) {
    throw new Error(
      `cannot read sql/insights/benchmark/${name}. This app reads shipped query text from the ` +
        `repo checkout; run it from the frontend/ directory inside the repo. (${(cause as Error).message})`,
    )
  }
  cache.set(name, text)
  return text
}

/** Runs an insight query against the insight database. */
export function insightQuery<P extends object>(sql: string, params: P) {
  return chQuery(sql, params, INSIGHT_DATABASE)
}

/**
 * Every insight query takes the same seven filters plus the isolation boundary, exactly matching
 * the serving-layer contract in lib/filters.ts. Same defaults, same meaning of '' and 0, so a
 * dimension filter behaves identically on both consoles and a reader comparing them is comparing
 * the data rather than two filter implementations.
 *
 * frozen_before is server-side and NOT client-controllable here for the same reason it is not
 * there: a client able to move the isolation boundary could pull unvalidated rows into a number
 * the ledger claims is fixed.
 */
export function parseInsightFilters(searchParams: URLSearchParams): Filters {
  return {
    platform: searchParams.get('platform') || '',
    country: searchParams.get('country') || '',
    video_type: searchParams.get('video_type') || '',
    app_version: searchParams.get('app_version') || '',
    content_id: Number(searchParams.get('content_id') || 0) || 0,
    from_ts: searchParams.get('from') || '2000-01-01 00:00:00',
    to_ts: searchParams.get('to') || '2100-01-01 00:00:00',
    frozen_before: FROZEN_BEFORE,
  }
}
