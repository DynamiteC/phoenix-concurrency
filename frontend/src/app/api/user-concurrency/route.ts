// Session-independent concurrency: concurrent USERS, not sessions. Identical shape and
// guarantees to /api/concurrency (see that file's header comment), reading
// user_concurrency_deltas instead of concurrency_deltas — one person on a phone and a TV is two
// sessions and one viewer, which is the divergence Compare mode on the dashboard shows.
import {NextRequest, NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import {parseFilters} from '@/lib/filters'
import type {ApiError, ConcurrencyResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SQL = `
WITH filtered AS
(
    SELECT minute, sum(delta) AS d
    FROM user_concurrency_deltas
    WHERE ({platform:String}    = '' OR platform    = {platform:String})
      AND ({country:String}     = '' OR country     = {country:String})
      AND ({video_type:String}  = '' OR video_type  = {video_type:String})
      AND ({app_version:String} = '' OR app_version = {app_version:String})
      AND ({content_id:Int64}   = 0  OR content_id  = {content_id:Int64})
    GROUP BY minute
),
curve AS
(
    SELECT
        minute,
        toInt64(sum(d) OVER (ORDER BY minute ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS concurrency
    FROM filtered
),
windowed AS
(
    SELECT minute, concurrency
    FROM curve
    WHERE minute >= parseDateTimeBestEffort({from_ts:String})
      AND minute <  parseDateTimeBestEffort({to_ts:String})
    ORDER BY minute ASC
    WITH FILL STEP toIntervalMinute(1) INTERPOLATE (concurrency AS concurrency)
),
-- Reach: distinct USERS active at any point in the window — a different question from
-- concurrency (how many at once). sign = 1 reads the current state of the CollapsingMergeTree
-- without FINAL: a run's -1 retraction is simply never selected, so a stale +1 is never counted.
reach AS
(
    SELECT uniqExact(user_id) AS n
    FROM user_minute_runs
    WHERE sign = 1
      AND run_start < parseDateTimeBestEffort({to_ts:String})
      AND run_end   >= parseDateTimeBestEffort({from_ts:String})
      AND ({platform:String}    = '' OR platform    = {platform:String})
      AND ({country:String}     = '' OR country     = {country:String})
      AND ({video_type:String}  = '' OR video_type  = {video_type:String})
      AND ({app_version:String} = '' OR app_version = {app_version:String})
      AND ({content_id:Int64}   = 0  OR content_id  = {content_id:Int64})
)
SELECT
    minute,
    concurrency,
    max(concurrency)            OVER () AS peak_concurrency,
    argMax(minute, concurrency) OVER () AS peak_minute,
    round(avg(concurrency)      OVER (), 2) AS avg_concurrency,
    quantile(0.95)(concurrency) OVER () AS p95_concurrency,
    (SELECT n FROM reach)       AS reach
FROM windowed
ORDER BY minute ASC
`

export async function GET(req: NextRequest): Promise<NextResponse<ConcurrencyResponse | ApiError>> {
  const filters = parseFilters(req.nextUrl.searchParams)
  const t0 = Date.now()
  try {
    const result = await chQuery(SQL, filters)
    const points = result.data.map((row) => [String(row[0]), Number(row[1])] as [string, number])
    const last = result.data[result.data.length - 1]
    const body: ConcurrencyResponse = {
      points,
      peakConcurrency: last ? Number(last[2]) : 0,
      peakMinute: last ? String(last[3]) : '',
      avgConcurrency: last ? Number(last[4]) : 0,
      p95Concurrency: last ? Number(last[5]) : 0,
      reach: last ? Number(last[6]) : 0,
      ms: Date.now() - t0,
      rowsRead: result.statistics?.rows_read,
    }
    return NextResponse.json(body)
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
