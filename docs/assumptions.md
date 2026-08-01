# Assumptions

Living doc. Every ruling gets written down when it is made, with the reason. Judges score
trade-off reasoning, and four people cannot make the same call twice from memory.

Format: `- [date time] decision, because reason. Alternative rejected: X, because Y.`

## State Machine

Implemented in `sql/queries/validation/oracle_concurrency.sql`.

- [2026-08-01] **Event-primary, heartbeat gap as the fallback.** CLOSE on
  `AppBackgrounded`, `VideoSessionEnd`, `VideoError`. OPEN on everything else:
  `VideoSessionStart`, `VideoPlay`, `AppForegrounded`, and any heartbeat, which is itself
  proof of life. Because `AppBackgrounded` is explicitly not guaranteed, every open segment
  is also capped at the gap tolerance, so a dropped background event cannot extend an
  interval indefinitely. Alternative rejected: heartbeat-primary (ignore the state events
  entirely), because it discards a real signal that is present most of the time.
  **Known exposure:** where a background event is dropped and heartbeats keep arriving
  (a backgrounded player can still emit), we count inactive time until the cap. Quantify
  this before submission.
- [2026-08-01] **`pause` is not an `event_type`.** It lives in the `event` column of
  `VideoHeartbeat` rows: `pause` 27,340, `resume` 31,780, plus `speed-pause`/`speed-resume`
  and `AdPause`/`AdResume`. A state machine keyed only on `event_type` silently counts every
  paused minute as watching. Ours keys on both.
- [2026-08-01] **Paused: both readings built**, switched by `pause_inactive`. See the
  divergence log below.

## Timeout Rules

- [2026-08-01] **Gap tolerance 90 s**, chosen from the observed gap distribution (p90 40 s,
  p99 76 s, max 40 h), not from the nominal 60 s heartbeat. 60 s would falsely split ~1% of
  normal traffic; 120 s would credit two minutes of silence as watching. Single constant
  (`tolerance_s`), so it is one query to re-check on the unseen day.
- [2026-08-01] An open segment with no following event runs to `last_event + tolerance` and
  no further. That is also the provisional-close rule for still-open sessions.
- Lateness tolerance / watermark: **open**, decided in phase 3.

## Session-Aware vs Session-Independent Divergence Log

Where two readings of the same data disagree, by how much, and which one we trust.

**Paused time (oracle, tolerance 90 s, whole sample file):**

| Reading | Peak | At | Avg over active minutes | Minutes with traffic |
|---|---|---|---|---|
| `pause_inactive=1` (paused excluded) | 3,323 | 2026-07-26 16:29 | 40.24 | 3,982 |
| `pause_inactive=0` (paused counted) | 3,338 | 2026-07-26 16:29 | 40.33 | 3,990 |

0.45% at peak. Small because pauses in this data are short: a spot-checked session shows
`pause → AppBackgrounded → AppForegrounded → resume` inside 1-3 seconds, so at minute grain
almost every pause is absorbed. Worth keeping because the unseen day may not behave this way,
and because the exclusion costs nothing once the state machine reads `event`.

**Naive session-span vs foreground (the overcount this problem exists to prevent):**

| Reading | Peak | Minutes with traffic |
|---|---|---|
| Naive: session counted start-to-end | 3,742 | 5,254 |
| Foreground-only oracle | 3,323 | 3,982 |

**12.6% overcount at peak, and 1,272 minutes (24%) that the naive model reports as having an
audience when nobody was actively watching.** Driven mostly by heartbeat silence, not by
backgrounding: backgrounds here are seconds long, gaps run to 40 hours.

Session-aware vs session-independent (per `video_session_id` vs per `user_id`): both are
emitted by the oracle already (`concurrent_sessions`, `concurrent_users`). Divergence gets
measured in phase 2 against the serving layer.

## Open Questions

- Watermark / lateness tolerance for phase 3.
- 25,810 events (2.9%) point at content rows whose `video_type` is blank. Decide whether a
  `video_type` filter should treat those as their own bucket or exclude them.
- `content` contains a sentinel row with `content_id = -987654322`. Harmless (no event
  references it), but do not assume ids are positive.
- Service is UTC, local `clickhouse local` is Asia/Kolkata. Both scripts now pin
  `session_timezone=UTC`. Any ad-hoc `clickhouse local` run outside them will be 5:30 off.
- `country` has exactly one value (`india`) in this sample. Stays in the serving key for the
  unseen day, but it buys no selectivity today and must not be relied on for pruning.
- Sample has **zero open sessions**; the unseen day is stated to have them. Open-session
  handling has to be tested against a deliberately truncated file, not this one.
- 10,880 starts and 10,881 ends against 10,866 distinct sessions: duplicate boundary events
  exist. Confirm the dedupe rule before the serving layer trusts them.

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

## Phase 2 gate (2026-08-01)

Serving layer matches the oracle **exactly**: 3,874 minutes, zero differing rows,
unfiltered, whole 12-day file.

Two bugs the gate caught, both invisible without it:

1. **Tied timestamps made concurrency non-deterministic.** Clients emit several events in
   the same millisecond (`BufferStart` / `video_forward` / `dropped-frames`). With ties,
   `leadInFrame` returns an arbitrary tied row, so the next-event lookup saw the *same*
   timestamp and the segment fell through to the full 90 s cap. Tie order is not stable
   between engines, so the same data gave different answers locally and on Cloud. Fixed by
   collapsing to one row per (session, second), a close beating an open at the same instant.
   This alone cut derived intervals from 851,919 to 364,769.
2. **Deltas per interval double-count.** A session pauses and resumes several times inside
   one minute, so an interval-level +1/-1 counted it repeatedly at that minute. Deltas are
   emitted from merged per-session minute runs instead, which is exactly what concurrency
   asks: was this session watching during minute M, once.

Scale of the serving layer: 905,558 events -> 364,769 intervals -> 16,136 minute runs ->
22,600 delta rows. Dashboards read the 22,600.

Benchmark latency, 26 July, day grain, warm:

| Query | Latency | Peak | Peak minute |
|---|---|---|---|
| All platforms | 15 ms | 2,959 | 10:56 |
| platform = ANDROID_PHONE | 8 ms | 1,807 | 10:56 |
| platform + country | 27 ms | 1,807 | 10:56 |
| video_type = live, hour grain | 23 ms | 444 | 10:45 |

The live slice peaks at 10:45 while the unfiltered curve peaks at 10:56, which is the
per-dimension-combination behaviour the problem statement calls out. A stored peak would be
wrong for every slice but the one it was computed for.

**100x note.** The cumulative sum starts at the first minute of the series, not at the start
of the queried range, so it reads the whole history of the filtered slice. At 12 days and
22,600 rows that is free. At 100x, insert periodic snapshot rows carrying the running total
at day boundaries so the sum starts from the nearest snapshot.
