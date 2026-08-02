'use client'

import type {StatusResponse} from '@/lib/types'
import {istDateTime} from '@/lib/time'
import styles from './ConsoleHeader.module.css'

/** HyperDX. Localhost is where docker/clickstack/compose.yml puts it; override for a deployment. */
const clickstackUrl = process.env.NEXT_PUBLIC_CLICKSTACK_URL || 'http://localhost:8090'

/**
 * HyperDX enforces its login server-side (an unauthenticated /api/dashboards returns 401) and its
 * no-login local mode is a BUILD-time flag on the image, not a runtime one, so the sign-in cannot
 * be switched off without rebuilding it, and rebuilding it would discard the dashboards
 * scripts/clickstack_setup.sh provisions through the API. So the credential is carried here
 * instead of hidden: it is a fixed demo login on a container bound to localhost, and putting it
 * on the link is the difference between a judge seeing the observability stack and not.
 */
const CLICKSTACK_LOGIN = 'demo login: phoenix@example.com / PhoenixClickathon2026!'

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
        {/* The observability stack is a separate service by design (it watches the live stream,
            this console reads the frozen slice), but nothing in the product pointed at it, so a
            judge clicking through the UI could not find it. One link fixes that. */}
        <nav className={styles.links} aria-label="Related consoles">
          <a href="/v2">insights console</a>
          <a href={clickstackUrl} target="_blank" rel="noreferrer" title={CLICKSTACK_LOGIN}>
            ClickStack
          </a>
        </nav>
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
