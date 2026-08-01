'use client'

import type {StatusResponse} from '@/lib/types'
import {istDateTime} from '@/lib/time'
import styles from './ConsoleHeader.module.css'

interface Props {
  status: StatusResponse | null
  error: string | null
}

export default function ConsoleHeader({status, error}: Props) {
  const nf = new Intl.NumberFormat('en-IN')
  return (
    <header className={styles.header}>
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
          <span className={styles.metricValue}>{status ? nf.format(status.events) : '--'}</span>
          <span className="mono-label">events ingested</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{status ? istDateTime(status.latestEvent) : '--'}</span>
          <span className="mono-label">latest event, IST</span>
        </div>
      </div>
    </header>
  )
}
