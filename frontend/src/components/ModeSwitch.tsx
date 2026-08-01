'use client'

import type {Mode} from '@/lib/types'
import styles from './ModeSwitch.module.css'

interface Props {
  mode: Mode | 'compare' | 'open'
  onChange: (mode: Mode | 'compare' | 'open') => void
}

const OPTIONS: { id: Mode | 'compare' | 'open'; label: string; hint: string }[] = [
  {id: 'sessions', label: 'Sessions', hint: 'session-aware'},
  {id: 'users', label: 'Users', hint: 'session-independent'},
  {id: 'compare', label: 'Compare', hint: 'both, overlaid'},
  // Deliberately last and deliberately not a curve: it reads raw_events, so it is a drill-down
  // the viewer asks for rather than something the refresh loop pays for.
  {id: 'open', label: 'Open', hint: 'still counting'},
]

/** Console-style toggle bank, not a soft tab strip, each option reads as a physically thrown switch. */
export default function ModeSwitch({mode, onChange}: Props) {
  return (
    <div className={styles.bank} role="tablist" aria-label="Concurrency mode">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          role="tab"
          aria-selected={mode === opt.id}
          className={`${styles.switch} ${mode === opt.id ? styles.active : ''}`}
          onClick={() => onChange(opt.id)}
        >
          <span className={styles.label}>{opt.label}</span>
          <span className={styles.hint}>{opt.hint}</span>
        </button>
      ))}
    </div>
  )
}
