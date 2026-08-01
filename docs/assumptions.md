# Assumptions

Living doc. Every ruling gets written down when it is made, with the reason. Judges score
trade-off reasoning, and four people cannot make the same call twice from memory.

Format: `- [date time] decision, because reason. Alternative rejected: X, because Y.`

## State Machine

Which event types open, extend, and close an active interval.
`VideoSessionStart`, `VideoPlay`, `VideoHeartbeat`, `AppBackgrounded`, `AppForegrounded`,
`VideoSessionEnd`, `VideoError`. Note: `AppBackgrounded` / `AppForegrounded` are **not
guaranteed** events.

-

## Timeout Rules

Heartbeat gap tolerance, what closes an interval when no closing event ever arrives, how open
sessions at the end of the day are treated, lateness tolerance / watermark.

-

## Session-Aware vs Session-Independent Divergence Log

Where the two approaches disagree, by how much, and which one we trust for the benchmark.

-

## Open Questions

-

## Dataset facts (from `./scripts/profile.sh`, sample day file, 2026-08-01)

- 905,558 rows · 10,866 sessions · 9,618 users · 3,357 contents.
- `event_timestamp` and `session_start_epoch` are epoch **milliseconds**, not seconds.
- Span: 2026-07-14 21:13 to 2026-07-26 17:00 UTC. Not a single day, ~12 days.
- Event mix: `VideoHeartbeat` 843,600 · `AppBackgrounded` 14,700 · `AppForegrounded` 14,321 ·
  `VideoPlay` 10,883 · `VideoSessionEnd` 10,881 · `VideoSessionStart` 10,880 · `VideoError` 293.
- Counts differ per session: 10,866 distinct sessions but 10,880 starts and 10,881 ends, so
  there are duplicate/extra boundary events to dedupe.
- **Zero sessions are open** in this sample: every session has a `VideoSessionEnd`. The unseen
  day is stated to contain open ones, so open-session handling cannot be validated on this file.
- Backgrounded events outnumber foregrounded by 379: some backgrounds never resume.
- Gap between consecutive events in a session (seconds): p50 0.99, p90 40, p99 75.6,
  p99.9 978, max 142,528 (~40 h). Heartbeat is nominally 1/minute, so p90 at 40 s and p99 at
  76 s means the naive "gap > 60 s closes an interval" rule would cut ~1% of normal traffic.
  Threshold choice belongs in Timeout Rules above.
- `country` is `india` for the top 10 platform combinations: check whether it is the only value.
