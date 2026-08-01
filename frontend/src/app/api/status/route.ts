// What the pipeline has ingested: drives the console's live indicator and the dashboard's
// default time window. Query text lives in sql/queries/serving/ingest_status.sql, which
// explains why this route reports the live watermark and the frozen-corpus bounds separately.
import {NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import {FROZEN_BEFORE} from '@/lib/env'
import {columnReader, servingSql} from '@/lib/sql'
import type {ApiError, StatusResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse<StatusResponse | ApiError>> {
  const t0 = Date.now()
  try {
    const result = await chQuery(servingSql('ingest_status.sql'), {frozen_before: FROZEN_BEFORE})
    const row = result.data[0]
    if (!row) throw new Error('ingest_status.sql returned no rows')
    const col = columnReader(result.meta)
    const str = (name: string): string | null => {
      const v = col(row, name)
      return v != null ? String(v) : null
    }
    const body: StatusResponse = {
      events: Number(col(row, 'events') ?? 0),
      latestEvent: str('latest_event'),
      frozenEarliest: str('frozen_earliest'),
      frozenLatest: str('frozen_latest'),
      frozenBefore: FROZEN_BEFORE,
      sessionRuns: Number(col(row, 'session_runs') ?? 0),
      sessionDeltas: Number(col(row, 'session_deltas') ?? 0),
      userRuns: Number(col(row, 'user_runs') ?? 0),
      userDeltas: Number(col(row, 'user_deltas') ?? 0),
      ms: Date.now() - t0,
    }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
