'use client'

import type {ConcurrencyPoint} from '@/lib/types'
import styles from './ConcurrencyChart.module.css'

export interface ChartSeries {
  label: string
  color: string
  points: ConcurrencyPoint[]
}

interface Props {
  series: ChartSeries[]
}

const W = 1000
const H = 360
const PAD = {l: 52, r: 12, t: 18, b: 26}

function pathFor(points: ConcurrencyPoint[], max: number): string {
  if (!points.length) return ''
  const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => H - PAD.b - (max ? (v / max) * (H - PAD.t - PAD.b) : 0)
  return points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ')
}

/**
 * Hand-rolled SVG line/area chart. No charting dependency: the shape of this data (a dense,
 * WITH-FILL-densified per-minute series) is simple enough that a chart library buys nothing
 * but bundle size. Renders one filled glow area for a single series (Sessions or Users mode),
 * or plain overlaid strokes for two series (Compare mode) so neither line is visually favored.
 */
export default function ConcurrencyChart({series}: Props) {
  const nf = new Intl.NumberFormat('en-IN')
  const withPoints = series.filter((s) => s.points.length > 0)
  const max = Math.max(1, ...withPoints.flatMap((s) => s.points.map((p) => p[1])))
  const longest = withPoints.reduce((a, s) => (s.points.length > a.length ? s.points : a), [] as ConcurrencyPoint[])

  return (
    <div className={styles.wrap}>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          {series.map((s) => (
            <linearGradient id={`grad-${s.label}`} key={s.label} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.32"/>
              <stop offset="100%" stopColor={s.color} stopOpacity="0"/>
            </linearGradient>
          ))}
        </defs>

        {/* horizontal oscilloscope grid, labelled with the value not the pixel */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const v = Math.round(max * frac)
          const yPos = H - PAD.b - frac * (H - PAD.t - PAD.b)
          return (
            <g key={frac}>
              <line className={styles.grid} x1={PAD.l} x2={W - PAD.r} y1={yPos} y2={yPos}/>
              <text className={styles.axisLabel} x={4} y={yPos + 3}>
                {nf.format(v)}
              </text>
            </g>
          )
        })}

        {withPoints.length === 1 &&
          withPoints.map((s) => {
            const d = pathFor(s.points, max)
            const base = `${d} L${PAD.l + (W - PAD.l - PAD.r)} ${H - PAD.b} L${PAD.l} ${H - PAD.b} Z`
            return (
              <g key={s.label}>
                <path d={base} fill={`url(#grad-${s.label})`}/>
                <path d={d} fill="none" stroke={s.color} strokeWidth={1.8} className={styles.glow}/>
              </g>
            )
          })}

        {withPoints.length > 1 &&
          withPoints.map((s) => (
            <path
              key={s.label}
              d={pathFor(s.points, max)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.6}
              className={styles.glow}
            />
          ))}

        {longest.length > 0 && (
          <>
            <text className={styles.axisLabel} x={PAD.l} y={H - 6}>
              {longest[0]?.[0]}
            </text>
            <text className={styles.axisLabel} x={W - PAD.r - 140} y={H - 6} textAnchor="start">
              {longest[longest.length - 1]?.[0]}
            </text>
          </>
        )}
      </svg>

      {series.length > 1 && (
        <div className={styles.legend}>
          {series.map((s) => (
            <span key={s.label} className={styles.legendItem}>
              <span className={styles.swatch} style={{background: s.color}}/>
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
