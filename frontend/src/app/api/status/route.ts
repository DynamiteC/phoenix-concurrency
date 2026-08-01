// What the pipeline has ingested so far: lets the console show ingestion keeping up (or a
// replay in progress) and gives the UI real earliest/latest bounds for the "all of data" range,
// instead of ever sending a pathological 2000-2100 window to the curve queries.
import {NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import type {ApiError, StatusResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SQL = `
SELECT
    (SELECT count() FROM raw_events)              AS events,
    (SELECT min(event_timestamp) FROM raw_events)  AS earliest,
    (SELECT max(event_timestamp) FROM raw_events)  AS latest,
    (SELECT sum(sign) FROM session_minute_runs)    AS session_runs,
    (SELECT count() FROM concurrency_deltas)       AS session_deltas,
    (SELECT sum(sign) FROM user_minute_runs)       AS user_runs,
    (SELECT count() FROM user_concurrency_deltas)  AS user_deltas
`

export async function GET(): Promise<NextResponse<StatusResponse | ApiError>> {
  const t0 = Date.now()
  try {
    const result = await chQuery(SQL, {})
    const row = result.data[0] || []
    const body: StatusResponse = {
      events: Number(row[0] ?? 0),
      earliest: row[1] != null ? String(row[1]) : null,
      latest: row[2] != null ? String(row[2]) : null,
      sessionRuns: Number(row[3] ?? 0),
      sessionDeltas: Number(row[4] ?? 0),
      userRuns: Number(row[5] ?? 0),
      userDeltas: Number(row[6] ?? 0),
      ms: Date.now() - t0,
    }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
