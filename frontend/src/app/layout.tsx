import type {Metadata} from 'next'
import {IBM_Plex_Mono} from 'next/font/google'
import './globals.css'

// One face, console-wide: tabular-figure mono for every number (peak counts, latencies,
// timestamps, so digits never shift width on refresh) and for headline type too, leaning on
// weight/letter-spacing/size to read as signage rather than adding a second family.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'PHOENIX // Foreground Concurrency Console',
  description:
    'Live foreground-only streaming concurrency, session-aware and session-independent, served from ClickHouse.',
}

export default function RootLayout({children}: { children: React.ReactNode }) {
  return (
    <html lang="en">
    <body className={plexMono.variable}>{children}</body>
    </html>
  )
}
