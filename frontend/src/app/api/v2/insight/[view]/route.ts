// One handler for every insight view, because they share one contract: the same seven filters in,
// a named-column table out, and the read cost reported alongside the answer.
//
// A REGISTRY, NOT A PATH. `view` comes from the URL, so it is untrusted, and it is never used to
// build a filename. It is looked up in the closed map below and a miss is a 404, which is what
// keeps a request for `../../../etc/passwd` a typo rather than a file read.
//
// COLUMNS PASS THROUGH BY NAME rather than being restated per view. Each .sql file already names
// its output columns and each one is the single source of truth for its own shape; re-declaring
// them here would be a second copy to drift, which is the exact failure lib/sql.ts exists to
// prevent. The client reads by name off `meta`, never by position, so a column added to a query
// for the benchmark harness cannot shift which number appears under which label.
import {NextRequest, NextResponse} from 'next/server'
import {insightQuery, insightSql, parseInsightFilters, INSIGHT_DATABASE} from '@/lib/insights'
import type {ApiError, InsightTableResponse} from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** view name -> the shipped query that answers it, and the question it answers. */
const VIEWS: Record<string, {file: string; question: string; reads: string}> = {
  flow: {
    file: 'audience_snapshot_minute_trend.sql',
    question: 'How did the audience arrive and leave, minute by minute?',
    reads: 'audience_minute_snapshot',
  },
  states: {
    file: 'state_flow.sql',
    question: 'How many backgrounded, how many came back, how many went silent?',
    reads: 'session_state_transitions',
  },
  retention: {
    file: 'cohorts_retention_curve.sql',
    question: 'Did the viewers it gained actually stay?',
    reads: 'content_entry_cohorts',
  },
  health: {
    file: 'health_incident_window.sql',
    question: 'Did errors or heartbeat gaps cause the drop?',
    reads: 'playback_health_minute',
  },
  versions: {
    file: 'session_facts_app_version_health.sql',
    question: 'Which app version loses viewers?',
    reads: 'session_insight_facts',
  },
  spikes: {
    file: 'spike_explanation.sql',
    question: 'Why did concurrency spike, and was it healthy or short-lived?',
    reads: 'concurrency_spike_events',
  },
  lateness: {
    file: 'lateness_audit.sql',
    question: 'What arrived late, and did it change an answer we had already given?',
    reads: 'late_event_audit',
  },
}

// A query that does not reference a parameter simply ignores it, so every view is called with the
// same filter set even though the spike and lateness tables carry fewer dimensions. Their headers
// say which filters they can honour; passing an unused one is inert rather than silently wrong.

export async function GET(
  req: NextRequest,
  {params}: {params: Promise<{view: string}>},
): Promise<NextResponse<InsightTableResponse | ApiError>> {
  const {view} = await params
  const spec = VIEWS[view]
  if (!spec) {
    return NextResponse.json(
      {error: `unknown insight view "${view}". Known views: ${Object.keys(VIEWS).join(', ')}`},
      {status: 404},
    )
  }

  const filters = parseInsightFilters(req.nextUrl.searchParams)
  const t0 = Date.now()
  try {
    const result = await insightQuery(insightSql(spec.file), filters)
    return NextResponse.json({
      view,
      question: spec.question,
      // Named so a reader can go from a number on screen to the table it came from without
      // reading the SQL. This is the plan's Gate B evidence, made visible rather than filed.
      reads: spec.reads,
      database: INSIGHT_DATABASE,
      sqlFile: `sql/insights/benchmark/${spec.file}`,
      columns: result.meta.map((c) => c.name),
      rows: result.data,
      ms: Date.now() - t0,
      rowsRead: result.statistics?.rows_read ?? 0,
    })
  } catch (e) {
    return NextResponse.json({error: (e as Error).message}, {status: 500})
  }
}
