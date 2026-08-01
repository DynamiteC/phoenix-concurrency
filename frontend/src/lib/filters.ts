import {FROZEN_BEFORE} from './env'
import type {Filters} from './types'

/**
 * Parses the shared filter contract off a request's search params. Every dimension defaults to
 * '' (no filter) and content_id defaults to 0 (no filter) to match the {x:String}='' OR ...
 * pattern the SQL files use. from_ts/to_ts default to a wide-open bound: in practice the UI
 * always sends explicit bounds derived from /api/status's `latest`, so this default is only a
 * safety net for direct API calls, not a path the dashboard itself takes.
 */
export function parseFilters(searchParams: URLSearchParams): Filters {
  return {
    platform: searchParams.get('platform') || '',
    country: searchParams.get('country') || '',
    video_type: searchParams.get('video_type') || '',
    app_version: searchParams.get('app_version') || '',
    content_id: Number(searchParams.get('content_id') || 0) || 0,
    from_ts: searchParams.get('from') || '2000-01-01 00:00:00',
    to_ts: searchParams.get('to') || '2100-01-01 00:00:00',
    // NOT client-controllable. The serving queries take frozen_before as a parameter, and the
    // previous version of this app deleted the predicate from its inlined SQL instead of
    // supplying the parameter, which quietly pointed the dashboard at live-contaminated rows.
    // Server-side and fixed, so what the dashboard reports equals what evidence/ measured.
    frozen_before: FROZEN_BEFORE,
  }
}
