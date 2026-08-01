# Decisions register

One row per modelling decision: the question, the options and what each cost, the choice, who
decided, when, and the artifact that measured the impact.

**Why this file exists.** Several sessions independently re-derived the same ambiguities (ad
handling, the average denominator, the tolerance tail, multi-end sessions) and some were re-decided
differently each time. A judge asking "why this and not that" needs one file, and so does the next
session. Where a decision was made by a previous session and only recorded in
`docs/assumptions.md`, it is backfilled here with its original date.

"Decided by" is the team unless stated. Nothing here was decided by a coin toss: every row names
the measurement that settled it, or says explicitly that it is a judgement call awaiting an owner.

---

## D1. Foreground-only, not session-span

**Question.** Does a session count toward concurrency for its whole open-to-close span, or only
while playback is actually in the foreground?

| Option | Cost |
|---|---|
| Session span (naive) | Peak 3,742 over 5,254 minutes with traffic. Counts backgrounded apps and paused playback as viewers. |
| Foreground only | Peak 2,829 over 3,664 minutes. Requires a state machine and a gap tolerance. |

**Chosen:** foreground only. The naive reading overstates peak by 32 percent, and "how many people
are watching" is not "how many apps are open".

**Decided:** 2026-08-01. **Evidence:** `[V:naive_vs_foreground]`, `[V:naive_baseline]`.

## D2. Neutral heartbeats must not reopen a paused session

**Question.** The event vocabulary has 34 `VideoHeartbeat` values beyond the pause and resume
family. Do they carry state?

| Option | Cost |
|---|---|
| Default to open | A pause is cancelled by the next buffer-health or network-activity row, so paused time counts as watching. The error grows with the length of the pause, which is the thing being excluded. |
| Neutral, carry the last decisive state forward | Needs an `argMax` over a window in `event_state`. |

**Chosen:** neutral. An unrecognised event value is also neutral, never open, so a new event type
promised by the data dictionary cannot manufacture viewing time.

**Decided:** 2026-08-01. **Evidence:** `[V:unknown_vocabulary]`, `sql/schema/03_event_state.sql`.

## D3. Pause counts as not watching (`pause_inactive=1`)

**Question.** Is paused playback foreground viewing?

| Option | Peak | Avg over active minutes |
|---|---|---|
| `pause_inactive=1`, paused excluded | 3,323 | 40.24 |
| `pause_inactive=0`, paused counted | 3,338 | 40.33 |

**Chosen:** `pause_inactive=1`. The difference is 0.45 percent, so this is cheap either way, and it
is kept as a parameter rather than baked in precisely because it is a business definition rather
than a fact. `pause_inactive=0` re-measures it on any dataset without editing SQL.

**Decided:** 2026-08-01, previous session. **Evidence:** `docs/assumptions.md` divergence log.

## D4. `AdPause` and `AdResume` are pause and resume

**Question.** Is an ad break foreground viewing?

**Chosen:** treated as the pause family, so an ad break is not counted as watching the content.
Reversible via the same `pause_inactive` switch as D3.

**Decided:** 2026-08-01, previous session. **Evidence:** `[V:adpause_impact]`.

## D5. Dimensions come from the session's first event and are held constant

**Question.** 95 sessions report more than one platform and 120 more than one `user_id`.

| Option | Cost |
|---|---|
| Per-event dimensions | A session that drifts mid-minute is counted twice in that minute. Session-to-dimension stops being 1:1. |
| First event wins | Loses genuine roaming, if any exists. |

**Chosen:** first event wins. The multi-platform sessions look like dirty data rather than roaming,
and double-counting a session is a correctness failure while mis-attributing a rare session's
platform is a reporting one. The oracle reports **both** readings so the gap stays a measured
number rather than a definition.

**Decided:** 2026-08-01. **Evidence:** `sql/pipeline/01_derive_intervals.sql`,
`sql/queries/validation/oracle_concurrency.sql`.

## D6. 90-second gap tolerance

**Question.** How long does an event's state hold when nothing follows it?

**Chosen:** 90 seconds, as `tolerance_s`, a parameter rather than a literal. Silence longer than
the cap is not evidence of watching, whatever the last state said.

**Open:** the value itself is a judgement call fitted to this corpus's heartbeat cadence and has
not been swept. **Owner: unassigned.** A sweep over 30/60/90/120 with peak and average at each
would turn it from a choice into a measurement.

**Decided:** 2026-08-01, previous session.

## D7. The primary average is over all minutes in the range

**Question.** The denominator of "average concurrency" is a definition and the graded ground truth
is private.

| Definition | 2026-07-26 | Denominator |
|---|---|---|
| **All minutes in range, carried forward** (primary) | **88.06** | 1,440 |
| Minutes with a non-zero audience | 200.00 | 634 |
| First observed event to range end | see `serving/peak_average.sql` | varies |

**Chosen:** all minutes in range, as primary, with the others shipped alongside and labelled on
screen with their own denominators. Showing one number and calling it "the average" hides the
choice rather than making it; shipping all three is cheap insurance against a definition mismatch
that would otherwise cost the correctness score outright.

**Decided:** 2026-08-01. **Evidence:** `[V:runbook_validation]`, `[V:oracle_parity]`.

## D8. No interval may extend past the session's last `VideoSessionEnd`

**Question.** 385 intervals across 21 sessions ran past their session's last end event, 336 of
them by more than the gap tolerance, the worst by 2,171 seconds.

**The stated root cause was wrong, and it changed the fix.** TASK.md attributed this to the 14
sessions carrying multiple `VideoSessionEnd` events. Measured: those sessions account for **zero**
of the 385. The actual cause is reactivating events arriving *after* the last end (38 `resume`, 28
`AppForegrounded`, 13 `VideoPlay`), which flip `is_open` back to 1, after which the neutral
telemetry that follows carries that reopened state forward. Deduplicating end events would have
fixed nothing.

| Option | Cost |
|---|---|
| Leave it | A session that has ended keeps accruing foreground time. Peak overstated by 1, average by 0.14. |
| Cap intervals at the last end, drop those starting after it | Chosen. Loses any genuine post-end resumption, which we cannot distinguish from a spurious early end. |
| Treat post-end activity as a new session | Needs a session-splitting rule nobody has specified, and would change session counts, which are a graded number. |

**Chosen:** cap and drop. Errs toward not counting time we cannot prove was watched, consistent
with D2 and D5.

**Measured impact:** peak 2,829 to 2,828; `avg_all_minutes` 88.20 to 88.06; minutes with audience
635 to 634; user peak 2,749 to 2,748; oracle minutes 3,664 to 3,663.

**Decided:** 2026-08-01. **Evidence:** `[V:rebuild_swap_phoenix_next]`, `[V:oracle_parity]`,
`[V:rebuild_idempotence]`.

## D9. Rebuild by shadow database, not shadow tables

**Question.** How is a full re-derive made safe, given that a second derive doubles concurrency
and no sum-shaped invariant detects it?

| Option | Cost |
|---|---|
| `<table>_next` in the same database | **Silently broken.** `concurrency_deltas_mv` is attached `FROM session_minute_runs`, so building into `session_minute_runs_next` fires nothing, the shadow deltas come out empty, and a row-count check on the runs table passes on garbage. |
| Shadow database, then `EXCHANGE TABLES` across databases | Chosen. Gets its own copy of the whole schema, MVs included, so deltas populate exactly as in production. |
| Truncate and re-derive in place | The window of inconsistency is the whole derive rather than milliseconds. |

**Chosen:** shadow database. Source tables are exposed as views onto the live database rather than
copied, which is cheaper and removes a second snapshot that could differ. `derive.sh` keeps its
refusal on the live path as a second layer.

`EXCHANGE TABLES` across databases was verified on this Cloud service before being designed
around, per operating rule 0.4.

**Decided:** 2026-08-01. **Evidence:** `[V:rebuild_swap_phoenix_next]`, `[V:rebuild_idempotence]`.

**Amended 2026-08-01, shadow renamed to `phoenix_rebuild`.** The shadow defaulted to
`phoenix_next`, and `phoenix_next` is now the generation-2 database holding the insight layer.
`rebuild_swap.sh` drops its shadow at the start of every run and again at the end, so one rebuild
would have wiped it. The default moved to `phoenix_rebuild`; nothing else about D9 changes. The
evidence name is derived from the shadow database, so the next run writes claim
`rebuild_swap_phoenix_rebuild` and the two citations above remain correct as history: the artifact
they point at really was produced against a shadow called `phoenix_next`.

## D10. ClickStack is live; the console is frozen

**Question.** Should both surfaces read the same rows?

| Surface | Reads | Answers |
|---|---|---|
| ClickStack / HyperDX | live, unfiltered | is the pipeline healthy right now |
| Next.js console | `event_timestamp < 2026-08-01` | what is the graded number |

**Chosen:** deliberately different. A watermark-lag panel cannot be frozen, because freezing it is
what makes lag unobservable. A graded average cannot be live, because `concurrency_deltas` does
receive live rows, so the headline would drift away from every committed artifact between two page
refreshes.

`frozen_before` is server-supplied in the console and not client-settable, and the type system
enforces that: `ClientFilters` has no such field.

**Decided:** 2026-08-01. **Evidence:** `[V:clickstack_integration]`, `[V:frozen_slice_stability]`.

## D11. Read budgets live on the shipped queries, and reach carries its own

**Question.** Where do `max_rows_to_read` ceilings belong, and at what multiple?

**Chosen:** on the serving queries, at roughly 3x the measured worst shape. Not the exact figure:
the cumulative sum must be seeded by the whole series for the filter tuple, so the read grows with
the corpus rather than with the window, and an exact budget would breach on the first extra day and
turn a real signal into noise at the moment it matters.

`reach` gets a **separate file and a separate budget** rather than a column on the curve query,
because it reads the runs tables, and `force_primary_key = 1` would fail there: both runs tables
are ordered `(id, run_start, run_end)`, so a window predicate with no id prefix cannot engage the
key. That query scans by design, and saying so is better than asserting a key that does not prune.

**Decided:** 2026-08-01. **Evidence:** `[V:filter_shapes]`.

## D12. One directory owns shipped query text

**Question.** The dashboard inlined its SQL, forked from a benchmark copy measured at 185.95
against a true 88.20, and the correction was never ported.

**Chosen:** `sql/queries/serving/` is the only home. The console reads from disk and looks columns
up by name, so a column added for the benchmark harness cannot shift what appears under a label.
`scripts/check_query_sources.sh` asserts there is only one copy, rather than diffing two, because a
diff-based test passes whenever both copies are equally wrong, which is exactly the state the repo
was in.

The trade is explicit: the console now needs the repo checkout at runtime, as it already did for
`.env`. The two superseded queries are retained under `sql/queries/known-wrong/` as regression
fixtures, because a bug you cannot reproduce is one you do not understand.

**Decided:** 2026-08-01. **Evidence:** `[V:oracle_parity]`.
