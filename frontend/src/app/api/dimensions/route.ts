// Distinct filter values for the four dimensions the serving layer is keyed on.
// Query text lives in sql/queries/serving/dimension_values.sql.
import {NextResponse} from 'next/server'
import {chQuery} from '@/lib/clickhouse'
import {FROZEN_BEFORE} from '@/lib/env'
import {columnReader, servingSql} from '@/lib/sql'
import type {ApiError, DimensionsResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse<DimensionsResponse | ApiError>> {
  try {
    const result = await chQuery(servingSql('dimension_values.sql'), {frozen_before: FROZEN_BEFORE})
    const col = columnReader(result.meta)
    const values = result.data
      .map((row) => ({dim: String(col(row, 'dim')), value: String(col(row, 'value'))}))
      .filter((v) => v.value !== '') as DimensionsResponse['values']
    return NextResponse.json({values})
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
