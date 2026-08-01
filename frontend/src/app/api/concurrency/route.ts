// Session-aware concurrency: minute curve plus peak/avg for the window, in one round trip.
// SQL mirrors the pipeline's own production query (sql/queries/benchmark/concurrency.sql) —
// kept inline here so this app is self-contained and deployable without the rest of the repo.
//
// Every filter is optional ('' / 0 = no filter on that dimension), passed only as ClickHouse
// query parameters, never string-built into the SQL.
//
// Three things this gets right, each of which is a way to be wrong:
// 1. The cumulative sum starts at the FIRST MINUTE OF THE SERIES, not at from_ts — a session
//    that opened before the window is still watching inside it. concurrency_deltas is ordered
//    by dimensions first, minute last, precisely so a time predicate cannot prune the cumsum,
//    only a dimension filter can.
// 2. The window is applied AFTER the sum, and peak is taken after that, so peak belongs to the
//    filtered slice: unfiltered traffic and one title peak at different minutes.
// 3. The series is densified (WITH FILL) before averaging, so quiet minutes aren't skipped.
//
// Two extra columns beyond the original benchmark query: p95_concurrency (sustained load, since
// peak alone can be a single one-minute spike) and reach (distinct sessions touched anywhere in
// the window — total audience, a different question from simultaneous concurrency).
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
    FROM concurrency_deltas
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
-- Reach: distinct SESSIONS active at any point in the window — a different question from
-- concurrency (how many at once). sign = 1 reads the current state of the CollapsingMergeTree
-- without FINAL: a run's -1 retraction is simply never selected, so a stale +1 is never counted.
reach AS
(
    SELECT uniqExact(video_session_id) AS n
    FROM session_minute_runs
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
    // Columns: minute, concurrency, peak_concurrency, peak_minute, avg_concurrency,
    // p95_concurrency, reach — the last five repeated on every row (window functions / scalar
    // subquery), so read them off the final row.
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
