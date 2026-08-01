// Session-aware concurrency: minute curve, peak, both averages, p95, and reach for a window.
//
// The query text is NOT here. It is read from sql/queries/serving/, the single source of truth
// for every shipped query. See src/lib/sql.ts for what the previous inline copy cost us: it was
// forked from the retired benchmark copies, which this repo had already measured at 185.95 against a
// true 88.20 over the same day, and the correction committed to serving/ was never ported.
//
// Two round trips, deliberately. reach reads the runs tables rather than the delta table, so it
// cannot share the curve's read budget or its force_primary_key assertion; the reasoning is
// written out in sql/queries/serving/reach.sql. They are issued in parallel.
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
      chQuery(servingSql('concurrency_curve.sql'), filters),
      chQuery(servingSql('reach.sql'), filters),
    ])

    // Read by column NAME, never by position: these files are shared with the benchmark and
    // validation harnesses, so a column added there must not silently shift which number
    // appears under which label here.
    const col = columnReader(curve.meta)
    const points = curve.data.map(
      (row) => [String(col(row, 'minute')), Number(col(row, 'concurrency'))] as [string, number],
    )

    // Peak, both averages and the two denominators are window functions over the whole result,
    // so every row repeats them and the last row is as good as any.
    const last = curve.data[curve.data.length - 1]

    // reach.sql returns one row per level: 'sessions' and 'users'.
    const reachCol = columnReader(reach.meta)
    const sessionsRow = reach.data.find((row) => String(reachCol(row, 'level')) === 'sessions')

    const body: ConcurrencyResponse = {
      points,
      peakConcurrency: last ? Number(col(last, 'peak_concurrency')) : 0,
      peakMinute: last ? String(col(last, 'peak_minute')) : '',
      avgConcurrency: last ? Number(col(last, 'avg_all_minutes')) : 0,
      avgActiveMinutes: last ? Number(col(last, 'avg_active_minutes')) : 0,
      minutesWithAudience: last ? Number(col(last, 'minutes_with_audience')) : 0,
      minutesInRange: last ? Number(col(last, 'minutes_in_range')) : 0,
      p95Concurrency: last ? Number(col(last, 'p95_concurrency')) : 0,
      reach: sessionsRow ? Number(reachCol(sessionsRow, 'reach')) : 0,
      ms: Date.now() - t0,
      rowsRead: (curve.statistics?.rows_read ?? 0) + (reach.statistics?.rows_read ?? 0),
    }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
