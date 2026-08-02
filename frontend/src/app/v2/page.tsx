import InsightConsole from './InsightConsole'
import './tokens.css'
import styles from './console.module.css'

export const metadata = {
  title: 'PHOENIX Insights // Audience Intelligence',
  description: 'Why concurrency moved, who moved with it, and whether they stayed.',
}

/**
 * The v2 console, reading the insight layer in phoenix_next.
 *
 * A SEPARATE ROUTE, not a tab on the v1 console, for two reasons that both point the same way.
 * The data is a different generation living in a different database, and the design language is
 * the deliberate inverse of v1's dark control room. Keeping them apart means the validated
 * concurrency console cannot regress because of anything done here.
 */
export default function V2Page() {
  return (
    <div className={`v2 ${styles.page}`}>
      <InsightConsole/>
    </div>
  )
}
