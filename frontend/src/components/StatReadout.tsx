'use client'

import styles from './StatReadout.module.css'

interface Props {
  label: string
  value: string
  accent?: 'signal' | 'cool' | 'neutral'
  size?: 'lg' | 'md'
}

/** A single big-number instrument panel — the console's equivalent of a VU meter readout. */
export default function StatReadout({label, value, accent = 'neutral', size = 'md'}: Props) {
  return (
    <div className={`${styles.readout} corner-ticks`}>
      <b className={`${styles.value} ${styles[accent]} ${size === 'lg' ? styles.lg : ''}`}>{value}</b>
      <span className={`mono-label ${styles.label}`}>{label}</span>
    </div>
  )
}
