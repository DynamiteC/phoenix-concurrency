# TASK: Ship the concurrency model — tables, materialized views, and the query set

**Repo:** phoenix-concurrency · **Branch:** feature/evidence-and-live-demo
**Owner of this task:** you (Claude Code) · **Deadline:** Click-a-thon submission, Aug 2
**Status:** we are behind on the core deliverable. Everything in this file is scoped to
closing that gap and making the solution legible to the whole team in the GitHub repo.

---

## 0. OPERATING RULES — read twice, they override everything below

You have hallucinated on this project already. This is not a hypothetical risk being
guarded against; it is a measured failure with a paper trail:

- Three of four published headline numbers were wrong and sat in the repo for a day
  (peak corrected 3,323 → actual 2,829; overcount 12.6% → actual 32.3%; phantom minutes
  1,272 → actual 1,592).
- Schema was inferred from repo SQL files that had drifted from the live server, and every
  scratch proof died on `NUMBER_OF_COLUMNS_DOESNT_MATCH`.
- A freshness key was adopted on the assumption that `ingested_at` held a stored value.
  It does not, for the rows that matter, and the resulting filter would have silently
  inverted the dataset.

Each of those was a confident statement that nobody had checked. So:

### 0.1 The verification rule
**No factual claim enters a commit, a doc, a comment, or a report unless you ran a command
this session that produced it.** Not "I know ClickHouse does X." Not "the schema is Y."
Not "this number was Z." Run it, capture it, cite it.

### 0.2 The tag discipline
Every claim in every document you write carries one of:
- `[V]` — verified this session. Must cite an evidence artifact path.
- `[A]` — assumption. Must state what would falsify it and who decides.
- `[U]` — unverified.

`[U]` is forbidden in any committed file. Resolve it to `[V]`, downgrade it to `[A]`, or
delete the claim. If you find yourself wanting to write `[U]`, that is the signal to run a
query instead.

### 0.3 The verification ledger
Maintain `evidence/LEDGER.tsv` with columns:
`claim_id | claim | command_or_script | artifact_path | status | verified_at_sha | verified_at_utc`

Every `[V]` claim in `docs/` references a `claim_id`. A judge, a teammate, or you-next-week
must be able to go from any sentence to the command that produced it in one hop.

### 0.4 Banned behaviours
- Writing SQL against a table whose columns you have not read from `system.columns` **in
  this session**. Repo SQL files are a hypothesis, not a source of truth.
- Using a ClickHouse setting, function, or table engine feature you have not confirmed
  exists on **our** server version via `system.settings`, `system.functions`, or
  `SELECT version()`. If it is not there, it does not exist for us.
- Restating any number from this task file, from a previous session, or from memory.
  Every number in your output is re-measured. This file's numbers are context, not data.
- Reporting a plan as a result. "I will add X" and "X is added and here is the row count"
  are different sentences and must not be blurred.
- Presenting a recommendation as a finding.
- Continuing past a failed assertion because the failure "looks harmless." You did this
  correctly once before — you stopped on the fairness gate and escalated. Repeat that.

### 0.5 Use everything available
MCP ClickHouse server for all introspection. `EXPLAIN indexes=1` and `EXPLAIN actions=1`
for plans. `system.query_log` for what queries actually read. The skills at
`/mnt/skills/user/database-war-room`, `database-optimizer`, `system-pressure-test`,
`ship-ready-review`, `debugging-strategies` — read the SKILL.md files before writing SQL,
not after. Fetch ClickHouse docs when a behaviour is in question rather than recalling it.
Parallelise independent verification queries.

---

## 1. OWNERSHIP BOUNDARIES

**Ingest is owned by a teammate and is currently running. Do not touch it.**
Do not modify the ingest script, the loader, or the live stream. Do not "fix" the
event-timestamp behaviour yourself.

What you **do** owe on ingest:
1. Isolate our work from it so our numbers are stable (§2.3).
2. File findings as `docs/issues/ingest-<n>.md` — one file per finding, each with the
   command that demonstrates it and its output. Known open item to document, not fix:
   the live stream carries August wall-clock event timestamps rather than source event
   time. Verify whether that is still true before writing it up; do not assume it from
   this file.

Everything else in this task is yours.

---

## 2. PHASE 1 — GROUND STATE (nothing else starts until this is committed)

You cannot build on a picture you have not looked at. Produce
`docs/GROUND_STATE.md`, every line `[V]` with a ledger reference.

### 2.1 What exists
- Every table in every `phoenix*` database: engine, full column list with types, ORDER BY,
  PARTITION BY, row count, part count, on-disk size. From `system.tables`, `system.columns`,
  `system.parts`. Not from `sql/`.
- Every materialized view: source table, target table, and the actual SELECT. Confirm each
  one is running and has not silently failed — `system.query_views_log` for exceptions.
- `SELECT version()`.
- The full distinct vocabulary of `event_type` and `event`, with counts. The data
  dictionary calls its list "current event types," which is an admission that it is not
  exhaustive.

### 2.2 What is contaminated
The live August stream shares `phoenix.raw_events` with the validated July corpus.
Determine — by measurement, per table — whether `foreground_intervals`,
`session_minute_runs`, `concurrency_deltas`, `user_minute_runs`,
`user_concurrency_deltas` contain rows derived from August events. Check by minute range,
by partition, and by `video_session_id` overlap between slices. Report blast radius
before touching anything.

### 2.3 Isolation
Adopt the frozen-slice predicate `event_timestamp < '2026-08-01'` for all validated work.
Do **not** use `ingested_at` for this — verify why yourself in one query before accepting
it: read `min(ingested_at)`, `max(ingested_at)`, `uniqExact(ingested_at)` over the July
rows three times a few seconds apart and look at what changes.

Default every validation and benchmark query to the frozen slice. Wire it as a single
parameter so the unseen day flips it, rather than as a literal scattered through the SQL.

**Gate:** run the validation set twice with live ingest continuing in between. Numbers must
be byte-identical. That artifact is the deliverable for Phase 1. If they are not identical,
stop and report — do not proceed to Phase 2 on unstable ground.

---

## 3. PHASE 2 — TABLES AND MATERIALIZED VIEWS (primary deliverable)

Deliver the final, documented, reproducible table set. Every DDL statement lives in a
versioned file under `sql/` and is applied by script. **Zero ad-hoc DDL against any
database, for any reason.** That rule is what would have prevented the mid-run ALTER that
cost us a day.

### 3.1 Structural fix: one database per dataset generation
```
phoenix          validated July corpus, frozen, read-mostly
phoenix_live     the teammate's live stream
phoenix_unseen   the sealed day, when it drops
phoenix_scratch_<task>   throwaway, dropped when done
```
Same DDL files applied to each; `load.sh` takes the target database as a parameter. This
replaces the social rule "announce your DDL," which has now failed twice. It also makes
the unseen-day drop `./load.sh <file> phoenix_unseen` instead of an improvised pipeline at
hour 22.

### 3.2 Idempotent derivation — fix this properly
The current batch derive asserts `sign=+1` unconditionally and appends. A second pass
appends duplicate runs that SummingMergeTree absorbs silently, with no undo. That is a
loaded gun pointed at the unseen day.

Replace with derive-to-shadow-and-swap: build into `<table>_next` in the same database,
verify row count and the closure property `sum(delta) = 0`, then `EXCHANGE TABLES ... AND`
atomically. Reruns become safe by construction rather than by discipline. Keep the
incremental arrival path (retraction rows into the live table) as it is — the swap pattern
is for full rebuilds only.

### 3.3 Vocabulary classifier that survives an unseen day
- Unknown `event_type`/`event` values default to **INACTIVE**, never active. Overcounting
  backgrounded time is the exact failure mode the problem exists to prevent, so the
  conservative default is the correct one.
- Emit an `UNKNOWN_VOCABULARY` report on every load: any value not in the classifier, with
  counts. On the unseen day this runs first and tells us in seconds whether a decision is
  needed. Build it now, not at hour 22.

### 3.4 Preserve the boundary rule exactly
Verify against the committed SQL, then keep:
- `interval_start` inclusive, `interval_end` exclusive
- `interval_end = least(if(next_ts > ts, next_ts, ts + tol), ts + tol)` — the 90s gap
  tolerance **does** extend the tail
- `minutes = timeSlots(interval_start, greatest(dateDiff('second', interval_start,
  interval_end) - 1, 0), 60)`
- `run_end` inclusive; deltas `+1` at `run_start`, `-1` at `run_end + 1 minute`

Do not "improve" this. It is validated. If you believe it is wrong, stop and escalate.

### 3.5 Document the table set for the team
`docs/DATA_MODEL.md`: one section per table — what it holds, what writes it, what reads
it, why the ORDER BY is what it is, and what it costs. Include a dataflow diagram in
Mermaid. A teammate who has not been in these sessions must be able to read this file and
understand the whole pipeline without asking anyone.

---

## 4. PHASE 3 — THE QUERY SET (primary deliverable)

`sql/queries/serving/` — the queries that answer the five questions in
PROBLEM_STATEMENT.md. Each is parameterised, committed, and has a measured result.
Remember `content_id` is Int64: a String query parameter needs `toInt64({content_id:String})`.

### 4.1 The seeding trap — check this first, I expect at least one existing query has it
To answer peak/average over `[t1, t2]`, the running sum **must be seeded by every delta
before t1**. Filtering deltas to the range and cumulative-summing inside it produces a
curve that starts at zero and is wrong for every range not beginning at the start of data.

Audit every existing benchmark query for this bug and report what you find. Then implement
correctly: read deltas `WHERE minute < t2` for the filter tuple, cumulative sum over
minute, restrict output rows to `>= t1`. Measure what that reads.

If the seed scan proves expensive, **measure whether sessions actually cross day
boundaries before building a checkpoint table.** A per-dimension-tuple baseline table
explodes combinatorially and may cost more than the scan it replaces.

### 4.2 Peak is not a rollup
Platform and platform+country peak at different minutes within the same range. Peak and
average are computed at query time from the per-minute series for the specific filter
requested, never pre-stored per rollup level. Write a test that would catch a regression
here: construct a filter pair where the peak minutes differ and assert they differ.

### 4.3 The average denominator is ambiguous and the ground truth is private
Average over all minutes in the range including zero-concurrency minutes, versus average
over non-zero minutes only, give materially different answers. Compute **both**. Ship
all-minutes-including-zeros as primary — it is the defensible definition of average
concurrency over a range — and report both in the submission with one line explaining the
choice. Cheap insurance against a definition mismatch we cannot see.

### 4.4 Filter-friendliness — measure, do not assert
`content_id` sits fourth in the ORDER BY, so a content-only filter cannot use the key
prefix. Judges look at what queries read, not just at latency.

For every benchmark filter shape — platform only, country only, content only,
platform+country, content+platform, video_type, unfiltered — capture `EXPLAIN indexes=1`
plus `read_rows`, `read_bytes`, `selected_marks`, `selected_parts` from
`system.query_log`. Put the table in `docs/problem/DESIGN.md`. **That table is a scoring
asset in its own right** — it is direct evidence for the criterion the judges named.

Only if content-only measures badly, choose between (a) a PROJECTION with content-leading
ORDER BY, or (b) a second MV-maintained deltas table with content-leading ORDER BY. Prefer
(b) unless (a) measures clearly better: projections on SummingMergeTree need
`optimize_use_projections` confirmed on our version, and there is a known interaction where
lazy materialization plus projections raises `AMBIGUOUS_COLUMN_NAME` (ClickHouse issue
#80201). A second table has no such surprise and its cost is legible. **Do not reorder the
existing key.**

### 4.5 Open sessions and late arrivals
The incremental path works. What is missing is the demo-facing proof. Produce one artifact
showing: curve at T → events arrive → curve at T+1 → the diff explained by exactly the
sessions that received events. That artifact is the answer to the "update handling"
criterion, which is graded.

### 4.6 Read budgets as assertions
Wrap each benchmark query with `max_bytes_to_read` / `max_rows_to_read` set slightly above
its measured read, and `force_primary_key = 1` where we claim key usage. The query then
**fails** if a schema change, a merge, or the unseen day's shape makes it read more than we
claim. "What your queries read" becomes machine-checked instead of asserted. A budget
breach on the unseen day is information we want loudly, not silently.

### 4.7 Benchmark hygiene
Query cache is banned from submission numbers. Do not use `use_query_cache` to produce
latencies. Report cold and warm separately and label every number. A judge who finds a
cached benchmark discards the whole submission.

---

## 5. PHASE 4 — THE TEAM-FACING PICTURE

The repo must show a working solution to a reader who was not in these sessions.

- `docs/STATUS.md` — what is done, what is in flight, what is not started, who owns each.
  Dated. This is the file a teammate opens first.
- `docs/DATA_MODEL.md` — §3.5.
- `docs/problem/DESIGN.md` — the decision log. Every design choice with its trade-off and
  its measured cost. This is what "design quality" is graded on.
- `docs/RUNBOOK_UNSEEN_DAY.md` — the exact command sequence for the sealed drop: load,
  vocabulary check, derive, verify, run benchmark set, capture evidence. Numbered steps,
  no prose, no decisions left open. Rehearse it against `phoenix_scratch_rehearsal` and
  record how long it took. A runbook that has never been run is a wish.
- `docs/corrections.md` — the before/after table of the wrong headline numbers, the
  artifact that caught each, the commit that fixed it. **Keep this.** It is the only way a
  judge can distinguish a team that validated from a team that got lucky. Do not delete
  corrective prose elsewhere in the repo to make a grep come back clean; the audit trail is
  the point.
- `README.md` updated to link all of the above.

---

## 6. LOWER PRIORITY — only after Phases 1–4 are committed

- Settings review against `https://clickhouse.com/docs/reference/settings/index` and
  `https://clickhouse.com/docs/reference/settings/server-settings/settings`. We are on
  ClickHouse Cloud, where most server-level settings are not user-modifiable — verify
  against `system.server_settings` before proposing anything from the second page. Focus on
  query-level and MergeTree table settings, which we control. Every setting we ship needs a
  measured before/after in `evidence/`. No cargo-culting settings to look tuned.
- Lazy materialization: `query_plan_optimize_lazy_materialization` (25.4+), applied
  automatically only up to the LIMIT threshold in
  `query_plan_max_limit_for_lazy_materialization` (default 10). Confirm both exist in
  `system.settings` on our version first. My prior is it does nothing for our benchmark set,
  because those are aggregations over a narrow LowCardinality delta table and aggregation
  reads every column it needs. Prove or disprove with `EXPLAIN actions = 1` — look for a
  `LazilyRead` operator in the plan; note it is also known not to appear on
  Distributed/cluster() paths. Test it where it plausibly helps instead: interval-detail or
  top-N-session queries returning wide rows with ORDER BY ... LIMIT. **Write the result into
  DESIGN.md either way.** "We tested it, it does not apply to our access pattern, here is the
  plan output" is a stronger answer than silence and far stronger than switching it on and
  implying credit.
- ClickStack / Langfuse / LibreChat integration (hard requirement, unstarted). Not this
  session, but do not design the telemetry surface so it needs retrofitting: the read
  budgets from §4.6 and the ingest-lag numbers are exactly what ClickStack would display.
  Emit them as structured output now so integration is wiring, not a rewrite.

---

## 7. DEFINITION OF DONE

- [ ] `docs/GROUND_STATE.md` committed, every claim `[V]` with a ledger reference
- [ ] Validation set produces byte-identical numbers across two runs with live ingest in between
- [ ] All DDL in versioned `sql/` files; zero ad-hoc DDL executed this session
- [ ] Full rebuild is idempotent and proven so by running it twice and diffing
- [ ] Every one of the five problem-statement questions has committed, parameterised,
      measured SQL behind it
- [ ] Filter-shape read table in DESIGN.md with `EXPLAIN` and `query_log` figures
- [ ] Read budgets committed on every benchmark query
- [ ] Unseen-day runbook rehearsed end to end, with a recorded wall-clock duration
- [ ] `evidence/LEDGER.tsv` complete; no `[U]` anywhere in `docs/`
- [ ] `docs/STATUS.md` accurate as of your final commit

---

## 8. REPORT FORMAT

Per phase: what you did · evidence artifact path · commit SHA · **what you could not
verify** · what you would do next with more time.

Stop and escalate on modelling decisions — present options with the cost of each and let a
human choose. Do not stop for cleanup decisions; make them and note them.

Before every commit, run this check on your own output: *for each factual statement, can I
name the command that produced it?* If not, delete the statement or go run the command. The
cost of a deleted sentence is zero. The cost of a wrong one is a day, and we have already
paid that once.
