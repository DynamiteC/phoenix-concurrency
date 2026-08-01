'use client'

import {useCallback, useEffect, useState} from 'react'
import type {InsightStatusResponse, InsightTableResponse} from '@/lib/types'
import {istDateTime} from '@/lib/time'
import styles from './console.module.css'

/** The nav. Each entry is a business question from the plan's section 21, not a table name:
 *  the table is shown underneath the answer, which is the right way round for a reader. */
const VIEWS = [
  {id: 'spikes', label: 'Spikes', blurb: 'why it moved, and did it hold'},
  {id: 'flow', label: 'Audience flow', blurb: 'arrivals, departures, and attention'},
  {id: 'states', label: 'State flow', blurb: 'backgrounded, returned, went silent'},
  {id: 'retention', label: 'Retention', blurb: 'did the audience it gained stay'},
  {id: 'health', label: 'Playback health', blurb: 'errors and heartbeat gaps'},
  {id: 'versions', label: 'App versions', blurb: 'which build loses viewers'},
  {id: 'lateness', label: 'Data quality', blurb: 'what arrived after we answered'},
] as const

type ViewId = (typeof VIEWS)[number]['id']

/** Hours back from the insight watermark. 'all' is kept because several of these tables are small
 *  enough to read whole and a cohort curve over the full corpus is a legitimate question. */
const RANGES = [
  {id: '1', label: 'last 1h of data'},
  {id: '3', label: 'last 3h of data'},
  {id: '24', label: 'last 24h of data'},
  {id: 'all', label: 'everything derived'},
] as const

type RangeId = (typeof RANGES)[number]['id']

function toCh(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * The window, anchored on the RAW watermark rather than the wall clock.
 *
 * Anchoring on `now` would be wrong in a way that looks right: the pipeline lags ingest, so "the
 * last hour" measured against a real clock can land entirely inside the gap and return nothing at
 * all, which reads as "no audience" rather than "not derived yet". Anchoring on the stream's own
 * latest event means the window always lands on data that exists.
 */
function windowFor(range: RangeId, rawLatest: string | null): {from: string; to: string} {
  if (range === 'all' || !rawLatest) return {from: '2000-01-01 00:00:00', to: '2100-01-01 00:00:00'}
  const end = new Date(`${rawLatest.replace(' ', 'T')}Z`)
  const to = toCh(new Date(end.getTime() + 60_000))
  const from = toCh(new Date(end.getTime() - Number(range) * 3_600_000))
  return {from, to}
}

const nf = new Intl.NumberFormat('en-IN')

/**
 * An identifier is a number that must never be read as a quantity. content_id 990001 formatted as
 * 9,90,001 invites a reader to compare it with a concurrency of 2,000, and it is not that kind of
 * number: it has no magnitude, no unit and no order. Detected by column NAME rather than by value,
 * because nothing about the digits themselves distinguishes the two.
 */
function isIdentifier(column: string): boolean {
  return column.endsWith('_id')
}

function fmt(value: unknown, column?: string): string {
  if (column && isIdentifier(column)) return value == null ? '-' : String(value)
  if (value == null) return '-'
  if (typeof value === 'number') return Number.isInteger(value) ? nf.format(value) : value.toFixed(2)
  const s = String(value)
  // ClickHouse hands back big integers as strings in JSONCompact. Format them as numbers so a
  // count and a rate do not sit in the same column looking like different kinds of thing.
  if (/^-?\d+$/.test(s)) return nf.format(Number(s))
  if (/^-?\d+\.\d+$/.test(s)) return Number(s).toFixed(2)
  // A bare timestamp is UTC off the wire and must not be printed as-is: every other time on this
  // page is IST, and one stray UTC value is worse than none.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return istDateTime(s)
  return s === '' ? '(none)' : s
}

/** Right-align anything numeric so columns compare down the page rather than across it. */
function isNumeric(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))
}

/**
 * A horizontal magnitude bar behind the leading measure of each row. Deliberately not a chart
 * library: the shape every one of these views needs is "rank these rows by one number", and a bar
 * width is the whole of that. It also degrades honestly, since a zero-width bar reads as zero.
 */
function Bar({value, max}: {value: number; max: number}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <span className={styles.barTrack} aria-hidden="true">
      <span className={styles.barFill} style={{width: `${pct}%`}}/>
    </span>
  )
}

function DataTable({data}: {data: InsightTableResponse}) {
  if (data.rows.length === 0) {
    return (
      <p className={styles.empty}>
        No rows. The query ran and the table it reads is empty for this window, which is a pipeline
        state rather than an error: see the watermarks in the header.
      </p>
    )
  }
  // The bar tracks the first numeric column that is actually a MEASURE. Skipping identifiers
  // matters: on the spike view the first numeric column is content_id, and a bar drawn from it
  // would rank spikes by which piece of content they happened to be about.
  const first = data.rows[0] ?? []
  const barCol = data.columns.findIndex((c, i) => isNumeric(first[i]) && !isIdentifier(c))
  const max = barCol >= 0 ? Math.max(...data.rows.map((r) => Number(r[barCol]) || 0)) : 0

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
        <tr>
          {data.columns.map((c, i) => (
            <th key={c} className={isNumeric(first[i]) && !isIdentifier(c) ? styles.num : ''}>
              {c.replace(/_/g, ' ')}
            </th>
          ))}
        </tr>
        </thead>
        <tbody>
        {data.rows.slice(0, 200).map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => {
              const column = data.columns[j] ?? ''
              return (
                <td key={j} className={isNumeric(cell) && !isIdentifier(column) ? styles.num : ''}>
                  {j === barCol && <Bar value={Number(cell) || 0} max={max}/>}
                  <span className={styles.cellValue}>{fmt(cell, column)}</span>
                </td>
              )
            })}
          </tr>
        ))}
        </tbody>
      </table>
    </div>
  )
}

/** Watermark row. Its job is to make staleness impossible to miss, so the lag is computed and
 *  labelled rather than left for the reader to subtract two timestamps in their head. */
function Watermarks({status}: {status: InsightStatusResponse}) {
  const raw = status.rawLatest ? Date.parse(`${status.rawLatest.replace(' ', 'T')}Z`) : 0
  const rows: {label: string; at: string | null; extra: string}[] = [
    {label: 'session facts', at: status.factsLatest, extra: `${nf.format(status.factsSessions)} sessions`},
    {label: 'minute snapshot', at: status.snapshotLatest, extra: `${nf.format(status.snapshotMinutes)} minutes`},
    {label: 'state transitions', at: status.transitionsLatest, extra: `${nf.format(status.transitionsAsserted)} asserted`},
    {label: 'playback health', at: status.healthLatest, extra: ''},
    {label: 'entry cohorts', at: status.cohortsLatest, extra: ''},
  ]
  return (
    <div className={styles.watermarks}>
      {rows.map((r) => {
        const t = r.at ? Date.parse(`${r.at.replace(' ', 'T')}Z`) : 0
        const lagMin = raw && t ? Math.round((raw - t) / 60000) : null
        const stale = lagMin != null && lagMin > 15
        return (
          <div key={r.label} className={styles.watermark}>
            <span className={styles.wmLabel}>{r.label}</span>
            <span className={styles.wmValue}>{istDateTime(r.at)}</span>
            <span className={`${styles.wmLag} ${stale ? styles.wmLagStale : ''}`}>
              {lagMin == null ? 'no data' : lagMin <= 0 ? 'current' : `${nf.format(lagMin)} min behind`}
            </span>
            {r.extra && <span className={styles.wmExtra}>{r.extra}</span>}
          </div>
        )
      })}
    </div>
  )
}

export default function InsightConsole() {
  const [view, setView] = useState<ViewId>('spikes')
  const [range, setRange] = useState<RangeId>('3')
  const [status, setStatus] = useState<InsightStatusResponse | null>(null)
  const [data, setData] = useState<InsightTableResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/v2/status', {cache: 'no-store'})
      .then((r) => r.json())
      .then((b) => (b.error ? setError(b.error) : setStatus(b)))
      .catch((e) => setError((e as Error).message))
  }, [])

  const load = useCallback((id: ViewId, r: RangeId, rawLatest: string | null) => {
    setLoading(true)
    setData(null)
    const {from, to} = windowFor(r, rawLatest)
    const qs = new URLSearchParams({from, to})
    fetch(`/api/v2/insight/${id}?${qs}`, {cache: 'no-store'})
      .then(async (r) => {
        const b = await r.json()
        if (!r.ok) throw new Error(b.error || `/api/v2/insight/${id} failed`)
        setData(b as InsightTableResponse)
        setError(null)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [])

  // Waits for the watermark before the first read, so the window is anchored on real data rather
  // than on a default that would have to be corrected a moment later.
  useEffect(() => {
    if (range !== 'all' && !status) return
    load(view, range, status?.rawLatest ?? null)
  }, [view, range, status, load])

  const spike = status?.spikeEvents ?? 0
  const late = status?.lateEvents ?? 0

  return (
    <>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>PHOENIX</span>
          <span className={styles.brandSub}>Insights</span>
        </div>

        <nav className={styles.nav} aria-label="Insight views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`${styles.navItem} ${view === v.id ? styles.navItemActive : ''}`}
              aria-current={view === v.id ? 'page' : undefined}
              onClick={() => setView(v.id)}
            >
              <span className={styles.navLabel}>{v.label}</span>
              <span className={styles.navBlurb}>{v.blurb}</span>
            </button>
          ))}
        </nav>

        <div className={styles.rangeBlock}>
          <label className={styles.footLabel} htmlFor="range">Window</label>
          <select
            id="range"
            className={styles.select}
            value={range}
            onChange={(e) => setRange(e.target.value as RangeId)}
          >
            {RANGES.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          <p className={styles.footNote}>
            Anchored on the latest ingested event, not on the wall clock: the insight layer lags
            ingest, so a window measured against a real clock can land inside the gap and return
            nothing.
          </p>
        </div>

        <div className={styles.sidebarFoot}>
          <span className={styles.footLabel}>reading</span>
          <code className={styles.footValue}>{status?.database ?? 'phoenix_next'}</code>
          {status && (
            <p className={styles.footNote}>
              {nf.format(status.rawEvents)} raw events, latest {istDateTime(status.rawLatest)} IST.
            </p>
          )}
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Concurrency tells you <mark className={styles.mark}>what</mark> changed.
            <br/>
            This tells you why.
          </h1>
          <p className={styles.heroLede}>
            The audience intelligence layer over the foreground-only concurrency engine. Every view
            below reads one purpose-built table and names it, along with what that read cost.
          </p>
        </header>

        {status && <Watermarks status={status}/>}

        {(spike === 0 || late === 0) && (
          <div className={styles.notice}>
            <strong>Two tables are still empty and their views are therefore not listed:</strong>{' '}
            {spike === 0 && <>spike detection has produced {spike} rows, </>}
            {late === 0 && <>the lateness audit has produced {late} rows. </>}
            They exist in the schema and their producers have not run. Reported here rather than
            shown as an empty chart, because an empty chart and a chart of zeroes look identical.
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {data && (
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{data.question}</h2>
              <div className={styles.evidence}>
                <span className={styles.evidenceItem}>
                  reads <code>{data.reads}</code>
                </span>
                <span className={styles.evidenceItem}>{data.ms} ms</span>
                <span className={styles.evidenceItem}>{nf.format(data.rowsRead)} rows read</span>
                <span className={styles.evidenceItem}>
                  <code>{data.sqlFile}</code>
                </span>
              </div>
            </div>
            <DataTable data={data}/>
          </section>
        )}

        {loading && <p className={styles.loading}>reading {view}...</p>}
      </main>
    </>
  )
}
