// Shared shapes between API route handlers (server) and components (client). Kept in one file
// because both sides of the fetch boundary need to agree on exactly this contract.

export type Mode = 'sessions' | 'users'

/**
 * What the UI controls. Everything here is client-supplied and therefore untrusted, which is
 * why it only ever reaches ClickHouse as param_* values and never as SQL text.
 */
export interface ClientFilters {
  platform: string
  country: string
  video_type: string
  app_version: string
  content_id: number
  from_ts: string
  to_ts: string
}

/**
 * The full parameter set a serving query receives. frozen_before is deliberately NOT part of
 * ClientFilters: the isolation boundary is a server-side decision, and a client able to move it
 * could pull live, unvalidated rows into a number the ledger claims is fixed.
 */
export type Filters = ClientFilters & {
  frozen_before: string
}

/** One [minute, concurrency] sample. Minute is the ClickHouse DateTime string, UTC. */
export type ConcurrencyPoint = [string, number]

export interface ConcurrencyResponse {
  points: ConcurrencyPoint[]
  peakConcurrency: number
  peakMinute: string
  /**
   * PRIMARY average: every minute in the requested range, with concurrency carried forward
   * across minutes that have no delta row. The denominator is a definition choice and the
   * ground truth is private, so avgActiveMinutes ships alongside it rather than instead of it.
   */
  avgConcurrency: number
  /** Average over only the minutes that had an audience. Same curve, smaller denominator. */
  avgActiveMinutes: number
  /** Minutes in the range with concurrency > 0. The denominator of avgActiveMinutes. */
  minutesWithAudience: number
  /** Every minute in the range, empty ones included. The denominator of avgConcurrency. */
  minutesInRange: number
  /** 95th percentile of the per-minute concurrency across the window, sustained load, distinct
   *  from peakConcurrency which can be a single one-minute spike. */
  p95Concurrency: number
  /** Distinct sessions (or users, on the user-concurrency response) active at ANY point in the
   *  window, a different question from concurrency: total reach, not simultaneous count. */
  reach: number
  ms: number
  rowsRead?: number
}

export interface StatusResponse {
  /** LIVE row count, no frozen predicate. The ingest-lag story. */
  events: number
  /** LIVE watermark. Drives the console's "is ingest keeping up" readout, NOT the window. */
  latestEvent: string | null
  /** Bounds of the VALIDATED corpus. The dashboard derives its default window from these,
   *  because every other serving query is frozen to that corpus. */
  frozenEarliest: string | null
  frozenLatest: string | null
  /** The boundary itself, surfaced so the UI can state what it is showing. */
  frozenBefore: string
  sessionRuns: number
  sessionDeltas: number
  userRuns: number
  userDeltas: number
  ms: number
}

export interface DimensionValue {
  dim: 'platform' | 'country' | 'video_type' | 'app_version' | 'content'
  /** What the query parameter takes. For content this is the content_id as a string. */
  value: string
  /** What a human reads. Equal to value for the four keyed dimensions; the title for content. */
  label: string
}

export interface DimensionsResponse {
  values: DimensionValue[]
}

/** One session that is still open at the watermark. */
export interface OpenSessionRow {
  videoSessionId: string
  platform: string
  country: string
  contentId: number
  lastEvent: string
  /** last_event + tolerance: how far the current answer already counts this session. */
  countedUntil: string
  /** Seconds of the current answer that a later heartbeat is still allowed to retract. */
  provisionalSeconds: number
  backgrounds: number
}

export interface OpenSessionsResponse {
  asOf: string
  toleranceSeconds: number
  /** Totals over EVERY open session, not over `rows`, which is one capped page. */
  openSessions: number
  provisionalSecondsTotal: number
  openWithBackground: number
  rows: OpenSessionRow[]
  ms: number
  rowsRead?: number
}

/**
 * One insight view's answer. Columns are carried alongside the rows rather than mapped into named
 * fields, because each shipped .sql file is the single source of truth for its own shape and a
 * second declaration here would be a copy to drift. The client reads by name off `columns`.
 */
export interface InsightTableResponse {
  view: string
  /** The business question this view answers, shown above it. */
  question: string
  /** The table it read. Named on screen so a number is one hop from its source. */
  reads: string
  /** Filters this view's query actually references. */
  honours: readonly string[]
  /** Filters it will silently ignore, surfaced so an inert control is stated, not discovered. */
  ignores: readonly string[]
  database: string
  sqlFile: string
  columns: string[]
  rows: unknown[][]
  ms: number
  rowsRead: number
}

/** Derivation watermarks, one per insight table, against the raw stream's own. */
export interface InsightStatusResponse {
  database: string
  rawLatest: string | null
  rawEvents: number
  factsLatest: string | null
  factsSessions: number
  snapshotLatest: string | null
  snapshotMinutes: number
  transitionsLatest: string | null
  transitionsAsserted: number
  healthLatest: string | null
  cohortsLatest: string | null
  /** Both expected to be zero until their producers run. Reported, never hidden. */
  spikeEvents: number
  lateEvents: number
  ms: number
}

export interface ApiError {
  error: string
}
