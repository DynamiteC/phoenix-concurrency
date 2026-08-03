'use client'

import {useEffect, useRef, useState} from 'react'
import {DATASET_LIST, type DatasetId} from '@/lib/datasets'
import {DatasetSwitch} from './DatasetSwitch'
import type {ConcurrencyResponse, DimensionValue, ClientFilters, Mode, StatusResponse} from '@/lib/types'
import {istDateTime, istInputToUtc, utcToIstInput} from '@/lib/time'
import {bucketPoints, type Grain} from '@/lib/grain'
import ConsoleHeader from './ConsoleHeader'
import FilterRail, {type RangeOption, type RefreshOption} from './FilterRail'
import ModeSwitch from './ModeSwitch'
import StatReadout from './StatReadout'
import ConcurrencyChart, {type ChartSeries} from './ConcurrencyChart'
import DivergenceBadge from './DivergenceBadge'
import OpenSessions from './OpenSessions'
import QueryPanel from './QueryPanel'
import styles from './Dashboard.module.css'

const EMPTY_FILTERS: ClientFilters = {
  platform: '',
  country: '',
  video_type: '',
  app_version: '',
  audio_language: '',
  subtitle_language: '',
  player_version: '',
  video_resolution: '',
  content_id: 0,
  from_ts: '',
  to_ts: '',
}

const nf = new Intl.NumberFormat('en-IN')

/** UTC "YYYY-MM-DD HH:mm:ss" -> Date. ClickHouse returns event times in this shape once
 *  session_timezone=UTC is pinned on every request. */
function toUtcDate(s: string): Date {
  return new Date(`${s.replace(' ', 'T')}Z`)
}

function toChTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** datetime-local input value ("YYYY-MM-DDTHH:mm") <-> ClickHouse "YYYY-MM-DD HH:mm:ss". The
 *  picker reads and writes IST because every other timestamp on screen is IST; the conversion
 *  back to UTC happens here, so the window sent to the API is still UTC. Both live in lib/time.ts
 *  with the display formatters, since they have to agree on the zone or the pickers disagree with
 *  the axis. */
const toInputValue = utcToIstInput
const fromInputValue = istInputToUtc

/** The window is relative to the INGEST clock, not the wall clock: `frozenLatest` is now the
 *  latest ingested event (the frozen horizon defaults to a no-op, see lib/env.ts), so "last 3h"
 *  means the 3h ending wherever ingest has reached and it advances on every status tick. Custom
 *  is the one exception, taking an explicit user-picked from/to rather than deriving one. */
/** The unseen corpus is one graded day (2026-07-31) plus a dirty tail of 1,640 stray rows
 *  spanning 2014 through 2026-08-03. The tail's max IS the ingest watermark, so anchoring the
 *  default window on frozenLatest lands on two days of near-empty noise instead of the day the
 *  dataset exists to show. Clamping the anchors to a one-day pad around the graded day makes
 *  every relative range (and 'all') land on real data; the tail stays reachable via custom. */
const UNSEEN_LATEST = '2026-08-01 00:00:00.000'
const UNSEEN_EARLIEST = '2026-07-24 00:00:00.000'

function clampUnseen(status: StatusResponse | null, dataset: DatasetId): StatusResponse | null {
  if (!status || dataset !== 'unseen') return status
  const latest =
    status.frozenLatest && status.frozenLatest > UNSEEN_LATEST ? UNSEEN_LATEST : status.frozenLatest
  const earliest =
    status.frozenEarliest && status.frozenEarliest < UNSEEN_EARLIEST
      ? UNSEEN_EARLIEST
      : status.frozenEarliest
  return {...status, frozenLatest: latest, frozenEarliest: earliest}
}

function windowFor(
  range: RangeOption,
  status: StatusResponse | null,
  customFrom: string,
  customTo: string,
): { from: string; to: string } | null {
  // NULL, NOT A HUNDRED-YEAR WINDOW.
  //
  // This line used to return 2000-01-01 -> 2100-01-01 as a "safe" default when the status poll
  // had not landed. It was the single most dangerous line in the app. Measured on the live host:
  // a normal 3h window answers in 0.52s; that fallback took 15.3s and, on three consecutive
  // probes, 500'd at 35.6s with "Timeout exceeded: elapsed 36729ms, maximum: 30000ms". The curve
  // query guarantees one row per minute with no gaps, so a century is ~52 million generated
  // minutes.
  //
  // Worse, it self-sustained: at 36s responses on a 5s timer each tab stacked ~7 in-flight
  // full-corpus scans. One transient status failure became a sustained outage of the mandatory
  // deliverable.
  //
  // A fallback must always be CHEAPER than the thing it replaces, never more expensive. There is
  // no cheap window to guess here, so the honest answer is to not ask. The caller skips the
  // fetch and the previous curve stays on screen until status returns.
  if (!status?.frozenLatest) return null
  const end = toUtcDate(status.frozenLatest)
  const to = toChTimestamp(new Date(end.getTime() + 60_000))
  const earliest = status.frozenEarliest ? toChTimestamp(toUtcDate(status.frozenEarliest)) : '2000-01-01 00:00:00'
  if (range === 'custom') {
    return {
      from: customFrom ? fromInputValue(customFrom) : earliest,
      to: customTo ? fromInputValue(customTo) : to,
    }
  }
  if (range === 'all') {
    return {from: earliest, to}
  }
  const hours = Number(range)
  const from = toChTimestamp(new Date(end.getTime() - hours * 3_600_000))
  return {from, to}
}

/** ClickHouse timeouts, dev-server recompiles, and proxy errors can all hand back a plain-text
 *  body ("Internal Server Error") instead of the route's JSON error shape. Parsing that with
 *  res.json() throws a SyntaxError whose raw message ("Unexpected token 'I' ...") is not
 *  something a viewer should ever see, so every fetch goes through the same safe parse and a
 *  bounded, human message. */
async function safeJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return {error: text.trim().slice(0, 140) || `${res.status} ${res.statusText}`}
  }
}

async function fetchConcurrency(
  path: string,
  filters: ClientFilters,
  dataset: DatasetId,
): Promise<ConcurrencyResponse> {
  const qs = new URLSearchParams()
  if (filters.platform) qs.set('platform', filters.platform)
  if (filters.country) qs.set('country', filters.country)
  if (filters.video_type) qs.set('video_type', filters.video_type)
  if (filters.app_version) qs.set('app_version', filters.app_version)
  if (filters.audio_language) qs.set('audio_language', filters.audio_language)
  if (filters.subtitle_language) qs.set('subtitle_language', filters.subtitle_language)
  if (filters.player_version) qs.set('player_version', filters.player_version)
  if (filters.video_resolution) qs.set('video_resolution', filters.video_resolution)
  if (filters.content_id) qs.set('content_id', String(filters.content_id))
  qs.set('from', filters.from_ts)
  qs.set('to', filters.to_ts)
  qs.set('dataset', dataset)
  const res = await fetch(`${path}?${qs}`, {cache: 'no-store'})
  const body = await safeJson(res)
  if (!res.ok) throw new Error(body.error || `${path} failed`)
  return body as ConcurrencyResponse
}

/** The query behind the numbers above it, with what it cost. See QueryPanel for why the text. */
function Provenance({data}: {data: ConcurrencyResponse}) {
  if (!data.sql || !data.sqlFiles) return null
  return (
    <QueryPanel
      sql={data.sql}
      files={data.sqlFiles}
      reads={data.reads}
      rowsRead={data.rowsRead}
      bytesRead={data.bytesRead}
      serverMs={data.serverMs}
      wallMs={data.ms}
    />
  )
}

/**
 * Every dimension the unseen day made filterable, keyed the same as ClientFilters, so a chip can
 * write straight into the filter state with no translation step.
 */
const SUGGESTABLE_DIMS: {key: keyof ClientFilters; label: string}[] = [
  {key: 'platform', label: 'platform'},
  {key: 'app_version', label: 'app version'},
  {key: 'video_type', label: 'video type'},
]

/**
 * Three chips built from whatever the dimension endpoint actually returned for the unseen
 * corpus, shown only on that dataset. The unseen day is one real day plus a dirty tail spanning
 * 2014-2026 (lib/datasets.ts), so an empty rail full of "all" dropdowns gives no hint that a
 * filter is worth touching at all; the first real value of each dimension is a starting point a
 * viewer would otherwise have to discover by opening every dropdown in FilterRail.
 */
function SuggestedFilters({
                             dims,
                             filters,
                             onFiltersChange,
                           }: {
  dims: DimensionValue[]
  filters: ClientFilters
  onFiltersChange: (next: ClientFilters) => void
}) {
  const chips = SUGGESTABLE_DIMS
    .map(({key, label}) => ({key, label, value: dims.find((d) => d.dim === key)?.value}))
    .filter((c): c is {key: keyof ClientFilters; label: string; value: string} => Boolean(c.value))
  if (chips.length === 0) return null

  return (
    <div className={styles.suggested}>
      <span className={styles.suggestedLabel}>Try</span>
      {chips.map((c) => {
        const active = filters[c.key] === c.value
        return (
          <button
            key={c.key}
            type="button"
            className={`${styles.chip} ${active ? styles.chipActive : ''}`}
            aria-pressed={active}
            // Clicking an active chip clears it rather than re-applying the same filter, so the
            // chip doubles as the only control needed to both set and unset the suggestion.
            onClick={() => onFiltersChange({...filters, [c.key]: active ? '' : c.value})}
          >
            {c.label}: {c.value}
          </button>
        )
      })}
    </div>
  )
}

export default function Dashboard() {
  const [dims, setDims] = useState<DimensionValue[]>([])
  const [filters, setFilters] = useState<ClientFilters>(EMPTY_FILTERS)
  // Original defaults to the 3h view, unchanged. The DatasetSwitch handler below sets this to
  // '24' the first time a viewer switches to the unseen dataset, because that corpus is one real
  // day (2026-07-31): a wide default window drags in the dirty tail behind it and renders a curve
  // that means nothing. 'all' stays selectable, it is just not what a first-time viewer lands on.
  // Switching back to original does not touch range at all, same as before this control existed.
  const [range, setRange] = useState<RangeOption>('3')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [grain, setGrain] = useState<Grain>('minute')
  const [refreshMs, setRefreshMs] = useState<RefreshOption>(5000)
  // No 'ask' here. LibreChat is the v2 conversational layer only: v1 is the concurrency
  // answer and its query, which is what the unseen-day deliverable is judged on.
  const [mode, setMode] = useState<Mode | 'compare' | 'open'>('sessions')
  // Which generation is on screen. Drives every fetch below, so switching it re-answers
  // the same question against the other dataset with the same SQL.
  const [dataset, setDataset] = useState<DatasetId>('original')

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [sessionData, setSessionData] = useState<ConcurrencyResponse | null>(null)
  const [userData, setUserData] = useState<ConcurrencyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTickAt, setLastTickAt] = useState<number>(() => Date.now())

  const timerRef = useRef<ReturnType<typeof setInterval>>()

  // Filter dropdown values, fetched once: the dimension set does not change while the
  // dashboard is open.
  // Refetched when the dataset changes: the two generations carry different content ids and
  // different dimension values, so a stale rail would offer filters that return nothing.
  useEffect(() => {
    fetch(`/api/dimensions?dataset=${dataset}`)
      .then((r) => r.json())
      .then((body) => setDims(body.values ?? []))
      .catch(() => setDims([]))
  }, [dataset])

  useEffect(() => {
    let cancelled = false

    async function tick() {
      setLastTickAt(Date.now())
      try {
        const statusRes = await fetch(`/api/status?dataset=${dataset}`, {cache: 'no-store'})
        const statusBody = await safeJson(statusRes)
        if (!statusRes.ok) throw new Error(statusBody.error || '/api/status failed')
        const s = statusBody as StatusResponse
        if (cancelled) return
        setStatus(s)
        const w = windowFor(range, clampUnseen(s, dataset), customFrom, customTo)
        if (!w) return   // no watermark yet: ask for nothing rather than for everything
        const {from, to} = w
        const withWindow: ClientFilters = {...filters, from_ts: from, to_ts: to}

        // 'open' fetches nothing here. That panel reads raw_events on demand and must not be
        // dragged onto this 5-second loop, and the curves it does not show cost nothing to skip.
        const wantSessions = mode === 'sessions' || mode === 'compare'
        const wantUsers = mode === 'users' || mode === 'compare'

        const [sess, usr] = await Promise.all([
          wantSessions ? fetchConcurrency('/api/concurrency', withWindow, dataset) : Promise.resolve(null),
          wantUsers ? fetchConcurrency('/api/user-concurrency', withWindow, dataset) : Promise.resolve(null),
        ])
        if (cancelled) return
        if (sess) setSessionData(sess)
        if (usr) setUserData(usr)
        setError(null)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }

    tick()
    clearInterval(timerRef.current)
    if (refreshMs) timerRef.current = setInterval(tick, refreshMs)
    return () => {
      cancelled = true
      clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // dataset is in here on purpose: switching generation must re-answer immediately rather
    // than wait for the next 5-second tick, and the stale curve must not linger under the
    // new label.
  }, [filters, range, mode, refreshMs, customFrom, customTo, dataset])

  /** Switching into custom seeds the pickers from whatever window is currently on screen
   *  (rather than opening blank) so the first thing the viewer sees matches what they were
   *  just looking at. */
  function handleRangeChange(r: RangeOption) {
    if (r === 'custom' && !customFrom && !customTo && status) {
      const seed = windowFor(range, clampUnseen(status, dataset), '', '') ?? {from: '', to: ''}
      setCustomFrom(toInputValue(seed.from))
      setCustomTo(toInputValue(seed.to))
    }
    setRange(r)
  }

  const series: ChartSeries[] = []
  if ((mode === 'sessions' || mode === 'compare') && sessionData) {
    series.push({
      label: 'Sessions',
      color: 'var(--signal)',
      points: bucketPoints(sessionData.points, grain),
      avg: sessionData.avgConcurrency,
      p95: sessionData.p95Concurrency,
      peakMinute: sessionData.peakMinute,
    })
  }
  if ((mode === 'users' || mode === 'compare') && userData) {
    series.push({
      label: 'Users',
      color: 'var(--cool)',
      points: bucketPoints(userData.points, grain),
      avg: userData.avgConcurrency,
      p95: userData.p95Concurrency,
      peakMinute: userData.peakMinute,
    })
  }

  const primary = mode === 'users' ? userData : sessionData
  const accent = mode === 'users' ? 'cool' : 'signal'

  return (
    <div className={styles.shell}>
      <ConsoleHeader status={status} error={error}/>
      <div className={styles.body}>
        <div className={styles.railColumn}>
          <DatasetSwitch
            datasets={DATASET_LIST}
            active={dataset}
            onChange={(id) => {
              // Clear the previous generation's curve before the new one lands. Leaving it on
              // screen under the new label is the one failure mode this control must not have.
              setSessionData(null)
              setUserData(null)
              setDataset(id)
              // The unseen corpus is one real day of live traffic (2026-07-31) plus a dirty tail
              // spanning 2014-2026 (lib/datasets.ts): 'all' or the default 3h window either render
              // a near-empty curve or one drowned in the tail. '24' is the real day. Only the
              // unseen path is touched here: switching to original leaves range exactly as it was,
              // same as before this control did anything to it at all.
              if (id === 'unseen') setRange('24')
            }}
          />
        <FilterRail
          dims={dims}
          filters={filters}
          onFiltersChange={setFilters}
          range={range}
          onRangeChange={handleRangeChange}
          customFrom={customFrom}
          onCustomFromChange={setCustomFrom}
          customTo={customTo}
          onCustomToChange={setCustomTo}
          boundsMax={status?.frozenLatest ? toInputValue(status.frozenLatest) : undefined}
          grain={grain}
          onGrainChange={setGrain}
          refreshMs={refreshMs}
          onRefreshChange={setRefreshMs}
          lastTickAt={lastTickAt}
        />
        </div>
        <main className={styles.main}>
          <div className={styles.toolbar}>
            <ModeSwitch mode={mode} onChange={setMode}/>
            {error && <span className={styles.errorTag}>{error}</span>}
          </div>

          {dataset === 'unseen' && (
            <SuggestedFilters dims={dims} filters={filters} onFiltersChange={setFilters}/>
          )}

          {mode === 'open' && <OpenSessions asOf={status?.latestEvent ?? null}/>}


          {mode !== 'compare' && mode !== 'open' && primary && (
            <div className={styles.stats}>
              <div className={styles.statsHero}>
                <StatReadout
                  label={mode === 'users' ? 'peak concurrent users' : 'peak concurrent sessions'}
                  value={nf.format(primary.peakConcurrency)}
                  accent={accent}
                  size="lg"
                />
                <StatReadout
                  label={mode === 'users' ? 'current concurrent users' : 'current concurrent sessions'}
                  value={nf.format(primary.points[primary.points.length - 1]?.[1] ?? 0)}
                  accent={accent}
                  size="lg"
                />
              </div>
              <div className={styles.statsSecondary}>
                {/* BOTH averages, each labelled with its own denominator. The right denominator
                    is a definition choice and the graded ground truth is private, so showing one
                    number and calling it "the average" hides the choice rather than making it. */}
                <StatReadout
                  label={`average, all ${nf.format(primary.minutesInRange)} min`}
                  value={primary.avgConcurrency.toFixed(2)}
                />
                <StatReadout
                  label={`average, ${nf.format(primary.minutesWithAudience)} active min`}
                  value={primary.avgActiveMinutes.toFixed(2)}
                />
                <StatReadout label="p95" value={nf.format(Math.round(primary.p95Concurrency))}/>
                <StatReadout label="peak minute, IST" value={istDateTime(primary.peakMinute)}/>
                <StatReadout
                  label={mode === 'users' ? 'users reached in window' : 'sessions reached in window'}
                  value={nf.format(primary.reach)}
                />
              </div>
              <div className={styles.statsMeta}>
                <StatReadout variant="inline" label="query latency" value={`${primary.ms} ms`}/>
                <StatReadout
                  variant="inline"
                  label="rows read"
                  value={primary.rowsRead != null ? nf.format(primary.rowsRead) : 'n/a'}
                />
              </div>
              <Provenance data={primary}/>
            </div>
          )}

          {mode === 'compare' && sessionData && userData && (
            <div className={styles.stats}>
              <div className={styles.statsHero}>
                <StatReadout
                  label="peak concurrent sessions"
                  value={nf.format(sessionData.peakConcurrency)}
                  accent="signal"
                  size="lg"
                />
                <StatReadout
                  label="peak concurrent users"
                  value={nf.format(userData.peakConcurrency)}
                  accent="cool"
                  size="lg"
                />
              </div>
              <div className={styles.statsSecondary}>
                <StatReadout
                  label="sessions reached in window"
                  value={nf.format(sessionData.reach)}
                  accent="signal"
                />
                <StatReadout
                  label="users reached in window"
                  value={nf.format(userData.reach)}
                  accent="cool"
                />
              </div>
              <Provenance data={sessionData}/>
              <Provenance data={userData}/>
              <DivergenceBadge
                sessionPeak={sessionData.peakConcurrency}
                userPeak={userData.peakConcurrency}
                sessionReach={sessionData.reach}
                userReach={userData.reach}
              />
            </div>
          )}

          {mode !== 'open' && <ConcurrencyChart series={series} grain={grain}/>}

          {mode !== 'open' && (
          <footer className={styles.footnote}>
            Curve is read from{' '}
            {mode === 'users' ? <code>user_concurrency_deltas</code> : <code>concurrency_deltas</code>}, a
            running sum of per-minute +1/&minus;1 rows, never recomputed from session history. Peak is
            evaluated after every filter is applied, because a platform slice and a platform+country
            slice peak at different minutes.
            {grain !== 'minute' && (
              <> The curve is drawn at <b>{grain}</b> grain, each bucket carrying the peak of the
                minutes inside it, so its highest point still equals the peak above. The readouts
                are unchanged by grain: they are computed over the dense minute series, which is
                the only denominator that gives a correct average.</>
            )}
          </footer>
          )}
        </main>
      </div>
    </div>
  )
}
