// Session-independent concurrency: concurrent USERS, not sessions. Identical shape and
// guarantees to /api/concurrency (see that file's header), reading user_concurrency_deltas
// instead of concurrency_deltas. One person watching on a phone and a TV is two sessions and
// one viewer, which is the divergence Compare mode on the dashboard exists to show.
//
// Query text lives in sql/queries/serving/, not here.
import {NextRequest, NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import {parseFilters} from '@/lib/filters'
import {columnReader, servingSql} from '@/lib/sql'
import type {ApiError, ConcurrencyResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse<ConcurrencyResponse | ApiError>> {
  const filters = parseFilters(req.nextUrl.searchParams)
  const t0 = Date.now()
  try {
    const [curve, reach] = await Promise.all([
      chQuery(servingSql('user_concurrency_curve.sql'), filters),
      chQuery(servingSql('reach.sql'), filters),
    ])

    const col = columnReader(curve.meta)
    const points = curve.data.map(
      (row) => [String(col(row, 'minute')), Number(col(row, 'concurrency'))] as [string, number],
    )
    const last = curve.data[curve.data.length - 1]

    const reachCol = columnReader(reach.meta)
    const usersRow = reach.data.find((row) => String(reachCol(row, 'level')) === 'users')

    const body: ConcurrencyResponse = {
      points,
      peakConcurrency: last ? Number(col(last, 'peak_concurrency')) : 0,
      peakMinute: last ? String(col(last, 'peak_minute')) : '',
      avgConcurrency: last ? Number(col(last, 'avg_all_minutes')) : 0,
      avgActiveMinutes: last ? Number(col(last, 'avg_active_minutes')) : 0,
      minutesWithAudience: last ? Number(col(last, 'minutes_with_audience')) : 0,
      minutesInRange: last ? Number(col(last, 'minutes_in_range')) : 0,
      p95Concurrency: last ? Number(col(last, 'p95_concurrency')) : 0,
      reach: usersRow ? Number(reachCol(usersRow, 'reach')) : 0,
      ms: Date.now() - t0,
      rowsRead: (curve.statistics?.rows_read ?? 0) + (reach.statistics?.rows_read ?? 0),
    }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
