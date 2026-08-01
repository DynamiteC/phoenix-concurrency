'use client'

import {useEffect, useRef, useState} from 'react'
import type {ConcurrencyResponse, DimensionValue, Filters, Mode, StatusResponse} from '@/lib/types'
import ConsoleHeader from './ConsoleHeader'
import FilterRail, {type RangeOption, type RefreshOption} from './FilterRail'
import ModeSwitch from './ModeSwitch'
import StatReadout from './StatReadout'
import ConcurrencyChart, {type ChartSeries} from './ConcurrencyChart'
import DivergenceBadge from './DivergenceBadge'
import styles from './Dashboard.module.css'

const EMPTY_FILTERS: Filters = {
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

/** The window is relative to the data's own clock, not the wall clock: during a replay the
 *  data is "now" even though its timestamps are historical. */
function windowFor(range: RangeOption, status: StatusResponse | null): { from: string; to: string } {
  if (!status?.latest) return {from: '2000-01-01 00:00:00', to: '2100-01-01 00:00:00'}
  const end = toUtcDate(status.latest)
  const to = toChTimestamp(new Date(end.getTime() + 60_000))
  if (range === 'all') {
    const from = status.earliest ? toChTimestamp(toUtcDate(status.earliest)) : '2000-01-01 00:00:00'
    return {from, to}
  }
  const hours = Number(range)
  const from = toChTimestamp(new Date(end.getTime() - hours * 3_600_000))
  return {from, to}
}

async function fetchConcurrency(path: string, filters: Filters): Promise<ConcurrencyResponse> {
  const qs = new URLSearchParams()
  if (filters.platform) qs.set('platform', filters.platform)
  if (filters.country) qs.set('country', filters.country)
  if (filters.video_type) qs.set('video_type', filters.video_type)
  if (filters.app_version) qs.set('app_version', filters.app_version)
  if (filters.content_id) qs.set('content_id', String(filters.content_id))
  qs.set('from', filters.from_ts)
  qs.set('to', filters.to_ts)
  const res = await fetch(`${path}?${qs}`, {cache: 'no-store'})
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || `${path} failed`)
  return body as ConcurrencyResponse
}

export default function Dashboard() {
  const [dims, setDims] = useState<DimensionValue[]>([])
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [range, setRange] = useState<RangeOption>('24')
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
        const s: StatusResponse = await fetch('/api/status', {cache: 'no-store'}).then((r) => r.json())
        if (cancelled) return
        setStatus(s)
        const {from, to} = windowFor(range, s)
        const withWindow: Filters = {...filters, from_ts: from, to_ts: to}

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
  }, [filters, range, mode, refreshMs])

  const series: ChartSeries[] = []
  if ((mode === 'sessions' || mode === 'compare') && sessionData) {
    series.push({label: 'Sessions', color: 'var(--signal)', points: sessionData.points})
  }
  if ((mode === 'users' || mode === 'compare') && userData) {
    series.push({label: 'Users', color: 'var(--cool)', points: userData.points})
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
          onRangeChange={setRange}
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
              <StatReadout label="average" value={nf.format(Math.round(primary.avgConcurrency))}/>
              <StatReadout label="p95" value={nf.format(Math.round(primary.p95Concurrency))}/>
              <StatReadout label="peak minute" value={primary.peakMinute.slice(0, 16) || '—'}/>
              <StatReadout
                label={mode === 'users' ? 'users reached in window' : 'sessions reached in window'}
                value={nf.format(primary.reach)}
              />
              <StatReadout label="query latency" value={`${primary.ms} ms`}/>
              <StatReadout label="rows read" value={primary.rowsRead != null ? nf.format(primary.rowsRead) : '—'}/>
            </div>
          )}

          {mode === 'compare' && sessionData && userData && (
            <div className={styles.stats}>
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
