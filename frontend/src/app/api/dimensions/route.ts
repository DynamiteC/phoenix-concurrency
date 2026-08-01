// Distinct filter values for the four dimensions the serving layer is keyed on. Read from
// concurrency_deltas (already deduplicated, tiny — 57 KiB per docs/ROADMAP.md) rather than
// raw_events, which would mean scanning the full 905K-row table for a dropdown.
import {NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import type {ApiError, DimensionsResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SQL = `
SELECT 'platform' AS dim, platform AS value FROM concurrency_deltas GROUP BY 1, 2
UNION ALL SELECT 'country', country FROM concurrency_deltas GROUP BY 1, 2
UNION ALL SELECT 'video_type', video_type FROM concurrency_deltas GROUP BY 1, 2
UNION ALL SELECT 'app_version', app_version FROM concurrency_deltas GROUP BY 1, 2
ORDER BY 1, 2
`

export async function GET(): Promise<NextResponse<DimensionsResponse | ApiError>> {
  try {
    const result = await chQuery(SQL, {})
    const values = result.data
      .map((row) => ({dim: String(row[0]), value: String(row[1])}))
      .filter((v) => v.value !== '') as DimensionsResponse['values']
    return NextResponse.json({values})
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
