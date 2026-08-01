# Reply: 30-minute validation runbook

Ran all 48 checks against live `phoenix` on 2026-08-01 at commit `d4f2906`. Filled results with
actuals per row: [`validation_runbook_filled.md`](validation_runbook_filled.md).

**35 PASS, 4 PARTIAL, 7 FAIL, 1 finding, 1 absent.** The 7 failures are checks 29, 30, 34, 42, 44,
46 and 47, clustering into 3 root causes: the corrected average is not wired into the demo, the
external integration is unstarted, and a set of submission-readiness items is untouched.

Every expected value you supplied that we could compare against reproduced exactly: 905,558 /
10,866 / 9,618 / 3,357 (test 6), 3,413 and 4,210 duplicates (12), 13 / 14 / 0 / 0 starts and ends
(13), peak 2,829 at 10:56 and user peak 2,749, difference 80 (23-26), 33,464 content rows with zero
duplicates (8-9).

Every number we measured for this review is committed to
`evidence/runbook_validation__20260801T145408Z__0ef547d-dirty.tsv` and reproducible with
`./scripts/runbook_validation.sh`, so you can re-derive any figure below without taking our word
for it.

## Three things you should read before the verdict

**1. Your reference average is biased low, and we can show it.** Test 28 returns 87.82 over
1,440 minutes. The denominator is right. The average is not: `curve` has one row per minute that
carries a delta, and **928 of the 1,440 minutes on 2026-07-26 have no delta row**. For those the
`LEFT JOIN` finds nothing and `ifNull(c.concurrency, 0)` scores them zero instead of carrying the
standing concurrency forward. We checked this against an independent last-observation-carried-forward
reference (`ASOF LEFT JOIN`, sharing no code with our serving SQL): **88.2** over the same 1,440
minutes, peak 2,829, 635 minutes with audience. Our corrected query returns 88.2 too. So the
correct full-day figure is 88.2 and yours under-reports by 0.38. Small, but it is the number the
whole phase turns on, and we would rather hand it back than quietly adopt it.

**2. The average bug you found is real, still shipped, and two lines from fixed.** Tests 29 and 30
reproduce your prior failure signature exactly: 00:10 to 11:32, 683 rows, average 185.95, and
246.98 respectively. The corrected queries exist in `sql/queries/serving/` with bounded
`WITH FILL FROM/TO` and a `seeded_window` CTE, and they return 88.2 over 1,440 minutes. But
`demo/server.js:22-23` still loads the old `sql/queries/benchmark/` files. **The fix is written
and not wired.** We are not claiming this one as fixed until it is.

One consequence of point 1 that you have to rule on: test 29's printed pass criterion is "average
matches Test 28". Test 28 as written returns 87.82, and the corrected query returns 88.2, so by the
criterion exactly as specified 29 and 30 can never pass. Accepting the fix means accepting 88.2 as
the reference.

**3. One check you expected to be clean is not: test 17.** Intervals extending past a known
session end return **385**, not 0. We tracked it down rather than explaining it away: 21 sessions
of 10,866, and 336 of the 385 exceed the 90s tolerance, so the tolerance tail does not cover it.
The cause is dirty data your own runbook measures at test 13, where 14 sessions emit more than one
`VideoSessionEnd`; 239 sessions carry events after their last end event, and our state machine
reopens on a subsequent `VideoPlay`. **Ceiling on the damage: peak is 2,829 with these sessions and
2,827 with all 21 removed entirely, so at most 2 sessions at peak.** That is a bound, not a
measurement, because removing a session also removes its legitimate pre-end viewing. We have not
measured the effect on the corpus average, and with a median overshoot of 760s it will not be
exactly zero. This is a definition question we should not answer unilaterally: honour the first end
event, or count observed playback after it? Your call.

## What genuinely fails

- **Test 44, external integration: absent.** No ClickStack, Langfuse, LibreChat or OTEL code
  anywhere. Only prose at `README.md:24` and `TASK.md:298`. Hard requirement, unstarted, and the
  largest risk on the board.
- **Test 42, lateness: no boundary, no quarantine.** Compounded by test 43: the `ingested_at`
  column that would measure lateness was added by a later `ALTER`, so on the July parts its
  `DEFAULT now()` evaluates at read time and it equals the reading query's own clock. Filtering on
  it kept 0 of 905,558 July rows and all August rows, exactly backwards. That needs an explicitly
  written arrival column before a lateness boundary means anything.
- **Test 46, ledger: two unresolved FAIL rows.** One is stale and should be retired:
  `naive_baseline_gate` was superseded when the gate was rewritten to clip to the overlapping
  range, and it now records `PASS`. The other, `derive_idempotence`, is real and deliberately
  recorded: running the batch derive twice doubles concurrency. It is a guard-rail gap, not a
  serving-path defect, but it is open.
- **Tests 34, 47, 48:** no title or category in the serving table, no TTL on any table, no
  per-query read budgets.

One smaller finding your runbook did not anticipate, ours to own: `video_type` carries an empty
string alongside `vod` and `live`, from the deliberate `LEFT JOIN` that keeps playback whose content
metadata is missing. Correct behaviour, but the dashboard needs a label for it.

Test 37 deserves a note on method rather than a finding. The literal query returns 185, not 0, but
none of those is a dashboard query: 183 are `ground_state.sh` invariant queries, and the runbook's
`ILIKE '%concurrency%'` heuristic cannot tell a validation query from a serving one. Read back
properly, across all replicas, the serving query's log entry is `tables = phoenix.concurrency_deltas`
and `read_rows = 26,904`, one table, matching our committed figure.

Two corrections to your expected values, both upward from our side: test 36 shows 10-15 ms cold
rather than 8-9 ms, and test 39's pass condition holds only for `platform`, which leads the sort
key. `country`, `content_id`, `video_type` and `app_version` each read the full 26,904 rows alone.
At 60 KiB that is a rounding error; at 100x it wants a content-first projection, and
`problem/DESIGN.md` section 7 already carries that as the known cost of putting dimensions first.

## Verdict

Your decision rule says REWORK REQUIRED when the required external integration is absent. It is
absent, and the average is wrong on the path the demo serves. **So the rule yields REWORK
REQUIRED, and that is what the filled runbook records.** We are not going to award ourselves the
softer verdict and back-fill the table to match.

The case for **APPROVED WITH CONDITIONS**, for you to accept or reject: the concurrency engine
itself is correct and checkable without trusting us. It matches a brute-force oracle at zero diffs
across 3,664 minutes on both the session and user paths, batch and incremental. `min_concurrency`
is 0, so deltas balance in order and not merely in total. `max_runs_per_session_minute` is 1, so no
session can be counted twice at one instant. Peak is proven not to be a rollup. Neither blocking
failure is a defect in that logic: one is a two-line wiring change with the fix already written and
tested, the other is an unstarted deliverable with no dependency on the engine.

The blocking item that argument has to survive, rather than route around, is test 17, which sits
squarely inside the foreground logic. Our case is that it is a definition question about dirty data
your own test 13 measures, not a logic error, and that its ceiling is 2 sessions at peak out of
2,829. If you read it as a logic defect instead, the conditional verdict does not hold and we would
accept that.

If you take that reading, the conditions we would accept as owned and dated are: wire the serving
queries, build the integration, rule on test 17, and retire or resolve the two ledger rows.

Recommended order, and we can start immediately: wire `demo/server.js` (minutes), then the
integration (the only item large enough to threaten the deadline), then your ruling on test 17
feeds a re-run of tests 17 through 20.
