// Shared shapes between API route handlers (server) and components (client). Kept in one file
// because both sides of the fetch boundary need to agree on exactly this contract.

export type Mode = 'sessions' | 'users'

export interface Filters {
  platform: string
  country: string
  video_type: string
  app_version: string
  content_id: number
  from_ts: string
  to_ts: string
}

/** One [minute, concurrency] sample. Minute is the ClickHouse DateTime string, UTC. */
export type ConcurrencyPoint = [string, number]

export interface ConcurrencyResponse {
  points: ConcurrencyPoint[]
  peakConcurrency: number
  peakMinute: string
  avgConcurrency: number
  /** 95th percentile of the per-minute concurrency across the window — sustained load, distinct
   *  from peakConcurrency which can be a single one-minute spike. */
  p95Concurrency: number
  /** Distinct sessions (or users, on the user-concurrency response) active at ANY point in the
   *  window — a different question from concurrency: total reach, not simultaneous count. */
  reach: number
  ms: number
  rowsRead?: number
}

export interface StatusResponse {
  events: number
  earliest: string | null
  latest: string | null
  sessionRuns: number
  sessionDeltas: number
  userRuns: number
  userDeltas: number
  ms: number
}

export interface DimensionValue {
  dim: 'platform' | 'country' | 'video_type' | 'app_version'
  value: string
}

export interface DimensionsResponse {
  values: DimensionValue[]
}

export interface ApiError {
  error: string
}
