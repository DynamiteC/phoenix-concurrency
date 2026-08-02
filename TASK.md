# TASK v2: Close out the concurrency solution

**Repo:** phoenix-concurrency · **Branch:** feature/evidence-and-live-demo
**Owner of this task:** you (Claude Code) · **Deadline:** Click-a-thon submission, Aug 2
**Supersedes:** TASK.md v1. Read that file for background only. Where the two disagree,
this file wins.

**Current verdict from independent review: REWORK REQUIRED.** 35 PASS, 4 PARTIAL, 7 FAIL,
1 finding, 1 absent across 48 checks. The verdict is driven by the missing external
integration, which is a binary requirement, plus a shipped wrong answer in the demo path
and an unresolved interval-truncation defect.

**Note on style:** this file avoids em-dashes because `check_docs.sh` bans them in
team-authored files. Keep it that way in anything you write. Organiser-supplied documents
under `docs/problem/` stay excluded from the checker; do not rewrite someone else's
document to satisfy our linter.

---

## 0. OPERATING RULES

These carry over from v1 unchanged in force, with three additions at the end. Read them
before anything else.

### 0.1 The verification rule
No factual claim enters a commit, a doc, a comment, or a report unless you ran a command
**this session** that produced it. Not "I know ClickHouse does X." Not "the schema is Y."
Not "this number was Z." Run it, capture it, cite it.

Every number in this file is context supplied by previous sessions. Treat all of them as
unverified. Rhackerrank-orchestrate-june26e-measure anything you intend to publish.

### 0.2 Tag discipline
Every claim in every document carries one of:
- `[V]` verified this session, citing an evidence artifact path
- `[A]` assumption, stating what would falsify it and who decides
- `[U]` unverified

`[U]` is forbidden in any committed file. Resolve it, downgrade it, or delete the claim.

### 0.3 The verification ledger
`evidence/LEDGER.tsv` stays current:
`claim_id | claim | command_or_script | artifact_path | status | verified_at_sha | verified_at_utc`

A `FAIL` row that records a negative finding and a `FAIL` row that records a broken gate
are different things. Add a `fail_kind` column with values `broken` or `finding` so the
next reader does not treat a deliberate red row as rot. Two rows currently need this.

### 0.4 Banned behaviours
- Writing SQL against a table whose columns you have not read from `system.columns` in this
  session. Repo SQL files are a hypothesis, not a source of truth.
- Using a ClickHouse setting, function, or engine feature you have not confirmed exists on
  our server via `system.settings`, `system.functions`, or `SELECT version()`.
- Restating a number from this file, a previous session, or memory.
- Reporting a plan as a result.
- Presenting a recommendation as a finding.
- Continuing past a failed assertion because the failure looks harmless.

### 0.5 New rule: sum-shaped invariants are blind to duplication
A previous session found that a second derive doubles concurrency from roughly 2,829 to
roughly 5,658, and that neither the closure check nor the per-session-minute overlap check
detects it. Closure survives because each duplicated `+1` carries its own `-1`. The overlap
check survives because the duplicate has an identical key.

**Any invariant that is a sum is structurally incapable of detecting duplication.** Audit
every gate you rely on and label each as sum-shaped or not. If a gate is sum-shaped, it is
asleep for this failure mode and something else must cover it. Write the audit into
`docs/problem/DESIGN.md`.

### 0.6 New rule: absence of a delta does not mean zero
This is the semantic core of the model and it has already produced one wrong shipped answer
and one wrong reference value.

A delta table is sparse by design. A minute with no delta row means **concurrency did not
change during that minute**, so the value carries forward. It does not mean concurrency was
zero. Any query that builds a minute spine and `LEFT JOIN`s deltas with `coalesce(..., 0)`
computes a sawtooth that collapses to zero between boundaries, and every aggregate over it
is wrong.

Peak is immune to this, which is why it survived undetected: peak only occurs at a delta
boundary. Average is not immune, which is why it was wrong.

Grep the entire repo for this pattern. It is a class of bug, not one bug. Every query that
reconstructs a per-minute series must carry the running sum forward across gap minutes.

### 0.7 New rule: cross-session corroboration
Two sessions have now independently reached the same corrected average (roughly 88.2, one
by fixing the query and one by an ASOF carry-forward reference). Where two independent
paths agree, say so in the artifact and name both paths. Where they disagree, that
disagreement is the highest-value thing in the report and goes at the top, not the bottom.

### 0.8 Use everything available
MCP ClickHouse server for all introspection. `EXPLAIN indexes=1` and `EXPLAIN actions=1`
for plans. `system.query_log` for what queries actually read. The skills at
`/mnt/skills/user/database-war-room`, `database-optimizer`, `system-pressure-test`,
`ship-ready-review`, `debugging-strategies`: read the SKILL.md files before writing SQL,
not after. Fetch ClickHouse docs when a behaviour is in question rather than recalling it.
Parallelise independent verification queries.

---

## 1. WHAT IS ALREADY DONE: DO NOT REDO

Verify cheaply that each still holds, then move on. Do not rebuild any of this.

- Ground state, contamination check, and frozen-slice isolation on
  `event_timestamp < '2026-08-01'`.
- Oracle parity: reported 4 of 4 at 0 diffs once the frozen-slice predicate was added to the
  benchmark queries. Before that fix the oracle was being compared against a serving layer
  containing August rows.
- Corrected headline numbers and `docs/corrections.md`.
- The naive-vs-corrected fairness gate.
- The average bug is diagnosed and a corrected query exists in `sql/queries/serving/`.
- `derive.sh` refuses a second derive.
- 48-check validation runbook, answered and committed under `docs/review/`.
- Expected values reproduced exactly by an independent reviewer: the corpus counts, the
  duplicate counts, the multi-end session counts, session peak and its minute, and the
  user-level peak with its difference from the session peak.

---

## 2. P0: BLOCKERS. Nothing below section 3 starts until these are closed.

### 2.1 External integration. Unstarted. This is the only requirement that can zero us.
The problem statement requires meaningfully integrating at least one of ClickStack,
Langfuse, or LibreChat, and states that superficial inclusion will not count. It has now
been deferred across three consecutive sessions and is FAIL on the review.

Build ClickStack over the structured TSV the pipeline already emits. It is the shortest
path and it is not superficial: the read budgets and ingest-lag numbers it would display
are the judges' own stated criteria, so the integration surfaces the thing we are graded on
rather than sitting beside it.

Minimum viable, in this order, each independently demoable so a partial finish still counts:
1. `docker/clickstack/compose.yml` using the all-in-one image. Verify the current image
   name and ports from the ClickHouse docs before writing the file; the image was renamed
   and older blog posts carry a stale path.
2. Register our ClickHouse as a HyperDX source and build the live dashboard on the delta
   table: minute-grain concurrency curve, platform and country filter, watermark-lag single
   stat. Panels must use `sum(delta)` with a running total. Do not use `FINAL`. Document
   panel definitions in `docs/clickstack.md` so it is reproducible on a fresh laptop.
3. Ship per-query spans carrying `read_rows`, `read_bytes`, and `elapsed_ms`, joined by
   `query_id` from `system.query_log`.

Layer 2 is the one that makes the integration load-bearing. If time collapses, sacrifice
layer 3, never layer 2.

### 2.2 The demo serves the wrong queries
The corrected average lives in `sql/queries/serving/`, but `demo/server.js` around lines
22 to 23 still loads the copies under `benchmark/`. The demo is what judges watch. It is
currently displaying a known-wrong number.

Fix by making one directory the single source of truth for query text. The demo, the
benchmark harness, and the submission all load from it. Delete or symlink the duplicates.
Then add a test that fails if any two copies of a query diverge, because this will recur
otherwise.

### 2.3 Intervals extend past session end
Reported: 385 intervals extend past a session's last `VideoSessionEnd`, across 21 sessions,
336 of them beyond the gap tolerance. Root cause is the 14 sessions carrying multiple
`VideoSessionEnd` events. The ceiling on peak is stated as 2 sessions, so peak is safe
within that bound, but **the effect on the average is unmeasured**.

This is a foreground-only correctness defect: a session that has ended cannot accrue
foreground time.

Measure the average impact first. Then apply this rule unless you can show it is wrong:

> `VideoSessionEnd` closes the current interval at its own timestamp. The gap tolerance
> never extends an interval past a `VideoSessionEnd`. Active events arriving after an end
> open a **new** interval rather than reviving the closed one. No interval may extend past
> the session's last end event.

That rule handles duplicate ends and genuine resumption with the same mechanism, and it
preserves foreground-only semantics. If you believe a different rule is correct, stop and
escalate with the measured impact of each option. Do not choose silently.

Record the outcome in the decisions register (section 5.1), re-run parity, and re-measure
peak, average, and phantom minutes afterwards.

### 2.4 Carry-forward audit
Per rule 0.6, sweep the repo for spine-join-coalesce-to-zero. Fix every instance. The
reference query used to validate the average had this bug, which means our own validation
scaffolding is affected, not only the serving queries.

---

## 3. P1: CORRECTNESS AND DEFENSIBILITY

### 3.1 Ship both average definitions
One number is currently shipped. The task file has asked twice for two, and the reason
stands, though its basis changed on 2026-08-02: the denominator is a definition choice, and
the revised problem statement judges correctness by spot-check against raw events rather than
against a private key. Every definition we ship therefore has to be reconcilable, and showing
one without naming its denominator hides the choice.

Ship all three candidates measured, one labelled primary:
- all minutes in the requested range, with concurrency carried forward across gap minutes
- minutes with non-zero concurrency only
- minutes from the first observed event to the range end

Primary is the first. State the choice in one line in the submission. This is cheap
insurance against a definition mismatch that would otherwise cost the correctness score
outright.

Also reconstruct the two wrong values exactly from their implied denominators. If you cannot
show precisely which minute set each was averaging over, the bug is not fully understood and
it will recur in a filter shape nobody tested.

### 3.2 Idempotent derivation. A refusal is not idempotence.
`derive.sh` refusing a second run is the correct immediate guard and should stay. It is not
the deliverable, and the Definition of Done box is still open.

On the unseen day we will plausibly need to re-derive after a bad vocabulary call or a
tolerance bug found late. Today the recovery path is a manual truncate plus re-derive under
time pressure, which is exactly the condition that reintroduces the doubling by hand.

Implement derive-to-shadow-and-swap: build into `<table>_next` in the same database, verify
row count and closure, then `EXCHANGE TABLES ... AND` atomically. Prove idempotence by
running the full rebuild twice and diffing. Keep the refusal on the live path as a second
layer.

### 3.3 The seeding test is probably confounded
A previous session reported the seeding trap absent, on the evidence that a 1-hour window
and a whole-corpus window read identical rows.

That is only evidence if the two windows had **different upper bounds**. If the 1-hour
window was at the end of the corpus, both queries share the same `t2`, both legitimately
read everything before it, and identical reads is a tautology.

Re-run with a 1-hour window at the **start** of the corpus, around 2026-07-14 16:00, against
the whole corpus. Report `read_rows` for start-window, end-window, and whole-corpus as three
rows.

Also fix the framing. "Nothing prunes, therefore correct" is not a pass; it means every query
pays worst case unconditionally, and what the queries read is a named judging criterion. The
property to demonstrate is: **read volume scales with the position of the range end in the
corpus, and never with the width of the window.** State whether that holds.

### 3.4 Lateness boundary
Reported FAIL: no defined lateness policy. Define one, enforce it, document it.

- How late may an event arrive and still be absorbed incrementally?
- What happens to an event arriving after that boundary: dropped, counted with a warning, or
  triggering a targeted re-derive of the affected sessions?
- How is the boundary measured, and what does the pipeline emit when it is crossed?

The problem statement grades update handling explicitly. An undefined boundary is an
undefined answer to a graded question.

### 3.5 Remaining review failures
Close or explicitly defer with a reason, each recorded in `docs/STATUS.md`:
- `title` and `category` dimensions from the content dataset
- TTL policy on the detail and delta tables
- read budgets on every benchmark query, per v1 section 4.6
- the two unresolved ledger rows, via the `fail_kind` column in rule 0.3

### 3.6 Frozen gate under concurrent writes
The gate is `PASS_BUT_INGEST_IDLE`: 33 metrics, 0 differing lines, but 0 rows arrived
because the replay loop had stopped. A run with no concurrent writes cannot demonstrate
stability under concurrent writes.

This needs the ingest owner to restart the loop, then `./scripts/frozen_gate.sh 120`. No
code change. **Flag it in your first message so the human can unblock it in parallel rather
than discovering it in your final report.**

---

## 4. P2: ONLY IF P0 AND P1 ARE CLOSED

### 4.1 Key order at realistic volume
The key-order experiment is currently uninformative rather than negative. At roughly 25K
delta rows the table is a few granules, so every candidate key prunes identically because
there is nothing to prune. The 36 percent disk difference for the rule-compliant key **is**
informative, because compression from ordering scales while pruning at three granules does
not. Report it that way.

The cheap unlock: you do not need 100x raw events, only 100x **delta rows**, and those can
be synthesized directly by fanning dimension tuples over the existing minute series. No
re-derive, no ingest, minutes of work. That converts "all keys prune identically" into a
real curve and turns the "how does this behave at 100x" question, which judges are told to
ask, from a paragraph into a measurement.

### 4.2 Settings and lazy materialization
Per v1 section 6, unchanged. We are on ClickHouse Cloud, so verify against
`system.server_settings` before proposing anything server-level. Every setting we ship needs
a measured before-and-after in `evidence/`. Write the lazy materialization result into
DESIGN.md either way; a measured negative is a stronger answer than silence.

---

## 5. DOCUMENTATION AND PROCESS

### 5.1 New: decisions register
Create `docs/DECISIONS.md`. One row per modelling decision: the question, the options with
their costs, the choice, who decided, the date, and the artifact that measured the impact.

The reason this file needs to exist: multiple sessions have independently re-derived the
same ambiguities (ad handling, average denominator, tolerance tail, multi-end sessions) and
some were re-decided differently. A judge asking "why this and not that" needs one file, and
so does the next session.

Backfill it with every decision already made, including the ones recorded only in
`docs/assumptions.md`.

### 5.2 Keep current
- `docs/STATUS.md`, dated, accurate as of your final commit, with an owner against every open
  item. This is the file a teammate opens first.
- `docs/DATA_MODEL.md`, `docs/problem/DESIGN.md`, `docs/RUNBOOK_UNSEEN_DAY.md`,
  `docs/corrections.md`, `README.md` linking all of them.

### 5.3 Add to corrections.md
Two self-caught errors belong there alongside the headline numbers:
- the claim that `max_runs_per_session_minute` detected the duplicate derive, published and
  then corrected when the query was actually run
- the reference average that scored gap minutes as zero, caught by an independent
  carry-forward reference

These are not embarrassments to bury. Judges scoring design quality have no way to
distinguish a team that validated from a team that got lucky, because both arrive with green
checkmarks. A team that arrives with green checkmarks **and** a written record of invariants
that failed and how they were caught is making a claim the lucky team cannot fake.

### 5.4 Push
Two commits are reported as unpushed on `feature/evidence-and-live-demo`. Push them. The
repo is the team's shared picture and it is currently stale.

---

## 6. DEFINITION OF DONE

Carried from v1 with status. Do not tick a box you have not re-verified this session.

- [x] `docs/GROUND_STATE.md` committed with ledger references
- [x] All DDL in versioned `sql/` files
- [x] Oracle parity at 0 diffs on the frozen slice
- [ ] Validation set byte-identical across two runs **with live ingest running between them**
      (blocked on ingest owner, section 3.6)
- [ ] Full rebuild idempotent, proven by running twice and diffing (section 3.2)
- [ ] External integration present and demoable (section 2.1)
- [ ] Demo, benchmark, and submission all load query text from one source (section 2.2)
- [ ] No interval extends past its session's last end event (section 2.3)
- [ ] No spine-join-coalesce-to-zero anywhere in the repo (section 2.4)
- [ ] All three average definitions measured, primary labelled (section 3.1)
- [ ] Seeding test re-run with differing upper bounds, framing corrected (section 3.3)
- [ ] Lateness boundary defined, enforced, documented (section 3.4)
- [ ] Read budgets committed on every benchmark query
- [ ] Unseen-day runbook rehearsed end to end with a recorded duration
- [ ] `evidence/LEDGER.tsv` complete, `fail_kind` populated, no `[U]` in `docs/`
- [ ] `docs/DECISIONS.md` backfilled
- [ ] `docs/STATUS.md` accurate, every open item has a named owner

---

## 7. REPORT FORMAT

Open your first message with anything that needs a human to unblock it in parallel. Do not
save blockers for the end.

Per section: what you did · evidence artifact path · commit SHA · **what you could not
verify** · what you would do next with more time.

Stop and escalate on modelling decisions, presenting options with the cost of each. Do not
stop for cleanup decisions; make them and note them.

Before every commit, run this check on your own output: for each factual statement, can I
name the command that produced it? If not, delete the statement or go run the command. The
cost of a deleted sentence is zero. The cost of a wrong one is a day, and we have paid that
twice.
