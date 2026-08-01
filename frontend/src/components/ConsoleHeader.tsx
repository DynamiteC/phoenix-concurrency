'use client'

import type {StatusResponse} from '@/lib/types'
import styles from './ConsoleHeader.module.css'

interface Props {
  status: StatusResponse | null
  error: string | null
}

export default function ConsoleHeader({status, error}: Props) {
  const nf = new Intl.NumberFormat('en-IN')
  return (
    <header className={`${styles.header} corner-ticks`}>
      <div className={styles.brand}>
        <h1 className={styles.title}>
          PH<span className={styles.o}>0</span>ENIX
        </h1>
        <span className={styles.subtitle}>Foreground-only concurrency console</span>
      </div>

      <div className={styles.readouts}>
        <div className={styles.statusPill}>
          <span className={`live-dot ${error ? 'error' : ''}`}/>
          {error ? 'signal lost' : 'live'}
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{status ? nf.format(status.events) : '—'}</span>
          <span className="mono-label">events ingested</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{status?.latest?.slice(0, 16) ?? '—'}</span>
          <span className="mono-label">latest event, UTC</span>
        </div>
      </div>
    </header>
  )
}
