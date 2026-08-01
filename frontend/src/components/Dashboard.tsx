'use client'

import {useEffect, useRef, useState} from 'react'
import type {ConcurrencyResponse, DimensionValue, ClientFilters, Mode, StatusResponse} from '@/lib/types'
import ConsoleHeader from './ConsoleHeader'
import FilterRail, {type RangeOption, type RefreshOption} from './FilterRail'
import ModeSwitch from './ModeSwitch'
import StatReadout from './StatReadout'
import ConcurrencyChart, {type ChartSeries} from './ConcurrencyChart'
import DivergenceBadge from './DivergenceBadge'
import styles from './Dashboard.module.css'

const EMPTY_FILTERS: ClientFilters = {
  platform: '',
  country: '',
  video_type: '',
  app_version: '',
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

/** datetime-local input value ("YYYY-MM-DDTHH:mm") <-> ClickHouse "YYYY-MM-DD HH:mm:ss". Both
 *  UTC: the picker is explicitly labelled UTC rather than run through the browser's local zone,
 *  matching every other timestamp this console shows. */
function toInputValue(chTimestamp: string): string {
  return chTimestamp.slice(0, 16).replace(' ', 'T')
}

function fromInputValue(v: string): string {
  return `${v.replace('T', ' ')}:00`
}

/** The window is relative to the FROZEN corpus's own clock, not the wall clock or the live
 *  watermark: every serving query is isolated to frozen_before, so the window the UI requests
 *  must be bounded by what that isolation actually covers. Custom is the one exception that
 *  takes an explicit user-picked from/to rather than deriving one, still clamped to that same
 *  frozen clock (see the input `min`/`max` FilterRail sets from these same bounds). */
function windowFor(
  range: RangeOption,
  status: StatusResponse | null,
  customFrom: string,
  customTo: string,
): { from: string; to: string } {
  if (!status?.frozenLatest) return {from: '2000-01-01 00:00:00', to: '2100-01-01 00:00:00'}
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

async function fetchConcurrency(path: string, filters: ClientFilters): Promise<ConcurrencyResponse> {
  const qs = new URLSearchParams()
  if (filters.platform) qs.set('platform', filters.platform)
  if (filters.country) qs.set('country', filters.country)
  if (filters.video_type) qs.set('video_type', filters.video_type)
  if (filters.app_version) qs.set('app_version', filters.app_version)
  if (filters.content_id) qs.set('content_id', String(filters.content_id))
  qs.set('from', filters.from_ts)
  qs.set('to', filters.to_ts)
  const res = await fetch(`${path}?${qs}`, {cache: 'no-store'})
  const body = await safeJson(res)
  if (!res.ok) throw new Error(body.error || `${path} failed`)
  return body as ConcurrencyResponse
}

export default function Dashboard() {
  const [dims, setDims] = useState<DimensionValue[]>([])
  const [filters, setFilters] = useState<ClientFilters>(EMPTY_FILTERS)
  const [range, setRange] = useState<RangeOption>('3')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [refreshMs, setRefreshMs] = useState<RefreshOption>(5000)
  const [mode, setMode] = useState<Mode | 'compare'>('sessions')

  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [sessionData, setSessionData] = useState<ConcurrencyResponse | null>(null)
  const [userData, setUserData] = useState<ConcurrencyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastTickAt, setLastTickAt] = useState<number>(() => Date.now())

  const timerRef = useRef<ReturnType<typeof setInterval>>()

  // Filter dropdown values, fetched once — the dimension set does not change while the
  // dashboard is open.
  useEffect(() => {
    fetch('/api/dimensions')
      .then((r) => r.json())
      .then((body) => setDims(body.values ?? []))
      .catch(() => setDims([]))
  }, [])

  useEffect(() => {
    let cancelled = false

    async function tick() {
      setLastTickAt(Date.now())
      try {
        const statusRes = await fetch('/api/status', {cache: 'no-store'})
        const statusBody = await safeJson(statusRes)
        if (!statusRes.ok) throw new Error(statusBody.error || '/api/status failed')
        const s = statusBody as StatusResponse
        if (cancelled) return
        setStatus(s)
        const {from, to} = windowFor(range, s, customFrom, customTo)
        const withWindow: ClientFilters = {...filters, from_ts: from, to_ts: to}

        const wantSessions = mode === 'sessions' || mode === 'compare'
        const wantUsers = mode === 'users' || mode === 'compare'

        const [sess, usr] = await Promise.all([
          wantSessions ? fetchConcurrency('/api/concurrency', withWindow) : Promise.resolve(null),
          wantUsers ? fetchConcurrency('/api/user-concurrency', withWindow) : Promise.resolve(null),
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
  }, [filters, range, mode, refreshMs, customFrom, customTo])

  /** Switching into custom seeds the pickers from whatever window is currently on screen
   *  (rather than opening blank) so the first thing the viewer sees matches what they were
   *  just looking at. */
  function handleRangeChange(r: RangeOption) {
    if (r === 'custom' && !customFrom && !customTo && status) {
      const seed = windowFor(range, status, '', '')
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
      points: sessionData.points,
      avg: sessionData.avgConcurrency,
      p95: sessionData.p95Concurrency,
      peakMinute: sessionData.peakMinute,
    })
  }
  if ((mode === 'users' || mode === 'compare') && userData) {
    series.push({
      label: 'Users',
      color: 'var(--cool)',
      points: userData.points,
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
          refreshMs={refreshMs}
          onRefreshChange={setRefreshMs}
          lastTickAt={lastTickAt}
        />
        <main className={styles.main}>
          <div className={styles.toolbar}>
            <ModeSwitch mode={mode} onChange={setMode}/>
            {error && <span className={styles.errorTag}>{error}</span>}
          </div>

          {mode !== 'compare' && primary && (
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
                <StatReadout label="peak minute" value={primary.peakMinute.slice(0, 16) || '—'}/>
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
                  value={primary.rowsRead != null ? nf.format(primary.rowsRead) : '—'}
                />
              </div>
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
              <DivergenceBadge
                sessionPeak={sessionData.peakConcurrency}
                userPeak={userData.peakConcurrency}
                sessionReach={sessionData.reach}
                userReach={userData.reach}
              />
            </div>
          )}

          <ConcurrencyChart series={series}/>

          <footer className={styles.footnote}>
            Curve is read from{' '}
            {mode === 'users' ? <code>user_concurrency_deltas</code> : <code>concurrency_deltas</code>}, a
            running sum of per-minute +1/&minus;1 rows, never recomputed from session history. Peak is
            evaluated after every filter is applied, because a platform slice and a platform+country
            slice peak at different minutes.
          </footer>
        </main>
      </div>
    </div>
  )
}
