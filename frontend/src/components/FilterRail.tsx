'use client'

import type {DimensionValue, ClientFilters} from '@/lib/types'
import styles from './FilterRail.module.css'

export type RangeOption = '3' | '24' | 'all'
export type RefreshOption = 0 | 5000 | 10000 | 30000 | 60000 | 300000

interface Props {
  dims: DimensionValue[]
  filters: ClientFilters
  onFiltersChange: (next: ClientFilters) => void
  range: RangeOption
  onRangeChange: (r: RangeOption) => void
  refreshMs: RefreshOption
  onRefreshChange: (ms: RefreshOption) => void
  /** Timestamp (Date.now()) of the last refresh tick, keys the countdown bar so it restarts
   *  every cycle instead of drifting out of sync with the actual fetch interval. */
  lastTickAt: number
}

const DIM_FIELDS: { key: 'platform' | 'country' | 'video_type' | 'app_version'; label: string }[] = [
  {key: 'platform', label: 'Platform'},
  {key: 'country', label: 'Country'},
  {key: 'video_type', label: 'Video type'},
  {key: 'app_version', label: 'App version'},
]

export default function FilterRail({
                                     dims,
                                     filters,
                                     onFiltersChange,
                                     range,
                                     onRangeChange,
                                     refreshMs,
                                     onRefreshChange,
                                     lastTickAt,
                                   }: Props) {
  const valuesFor = (dim: string) => dims.filter((d) => d.dim === dim).map((d) => d.value)

  return (
    <aside className={`${styles.rail} corner-ticks`}>
      <div className={styles.section}>
        <span className={styles.sectionTitle}>Dimensions</span>
        {DIM_FIELDS.map(({key, label}) => (
          <div key={key}>
            <label className="mono-label" htmlFor={key}>
              {label}
            </label>
            <select
              id={key}
              className={styles.select}
              value={filters[key]}
              onChange={(e) => onFiltersChange({...filters, [key]: e.target.value})}
            >
              <option value="">all</option>
              {valuesFor(key).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        ))}

        <label className="mono-label" htmlFor="content_id">
          Content ID
        </label>
        <input
          id="content_id"
          className={styles.select}
          type="number"
          placeholder="all"
          value={filters.content_id || ''}
          onChange={(e) => onFiltersChange({...filters, content_id: Number(e.target.value) || 0})}
        />
      </div>

      <hr className="hairline"/>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>Window</span>
        <label className="mono-label" htmlFor="range">
          Range
        </label>
        <select
          id="range"
          className={styles.select}
          value={range}
          onChange={(e) => onRangeChange(e.target.value as RangeOption)}
        >
          <option value="24">last 24h of data</option>
          <option value="3">last 3h of data</option>
          <option value="all">everything ingested</option>
        </select>

        <label className="mono-label" htmlFor="refresh">
          Auto refresh
        </label>
        <select
          id="refresh"
          className={styles.select}
          value={refreshMs}
          onChange={(e) => onRefreshChange(Number(e.target.value) as RefreshOption)}
        >
          <option value={5000}>every 5s</option>
          <option value={10000}>every 10s</option>
          <option value={30000}>every 30s</option>
          <option value={60000}>every 1 min</option>
          <option value={300000}>every 5 min</option>
          <option value={0}>off</option>
        </select>

        {refreshMs > 0 && (
          <div className={styles.timerTrack} aria-hidden="true">
            <div key={lastTickAt} className={styles.timerFill} style={{ animationDuration: `${refreshMs}ms` }} />
          </div>
        )}
      </div>
    </aside>
  )
}
