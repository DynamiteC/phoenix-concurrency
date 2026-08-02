-- The serving layer. Three tables, and the only one a dashboard ever reads is the last.
--
--   foreground_intervals   one row per active interval inside a session
--   session_minute_runs    those intervals merged into contiguous minute runs, per session
--   concurrency_deltas     +1 at run start, -1 after run end, per dimension tuple
--
-- Why runs and not intervals: a session pauses and resumes several times inside one minute
-- (measured: our spot-check session fragments 4 times in 60 seconds). Emitting a delta per
-- interval would count that session 4 times in that minute. Concurrency asks "was this
-- session watching during minute M", which is once. Merging to minute runs first makes the
-- delta model answer exactly that, and keeps cost proportional to boundaries, not watch time.

CREATE TABLE IF NOT EXISTS foreground_intervals
(
    video_session_id String,
    user_id          String,
    content_id       Int64,
    platform         LowCardinality(String),
    country          LowCardinality(String),
    app_version      LowCardinality(String),
    video_type       LowCardinality(String),
    interval_start   DateTime,
    interval_end     DateTime          -- exclusive
)
ENGINE = MergeTree
-- PARTITION BY, added 2026-08-01 to match the live schema (scripts/repartition_derived.sh).
-- Daily, mirroring raw_events. The purpose is LIFECYCLE, not scan pruning: these are exactly the
-- tables scripts/reset_live.sh must clear, and without a partition key that clearing has to be a
-- lightweight DELETE. That is a mutation, and worse, a DELETE followed by re-inserting rows which
-- match its predicate leaves the new rows MASKED, measured in this repo at 108,521 rows
-- physically present in system.parts and invisible to every SELECT.
-- Daily rather than monthly because the unseen day lands in the same month as the demo rows, and
-- a monthly key would make the mandatory pre-unseen-day cleanup impossible to do by partition.
PARTITION BY toYYYYMMDD(interval_start)
ORDER BY (video_session_id, interval_start);

CREATE TABLE IF NOT EXISTS session_minute_runs
(
    video_session_id String,
    user_id          String,
    content_id       Int64,
    platform         LowCardinality(String),
    country          LowCardinality(String),
    app_version      LowCardinality(String),
    video_type       LowCardinality(String),
    run_start        DateTime,         -- first minute the session is active in
    run_end          DateTime,         -- last minute the session is active in, inclusive
    -- +1 asserts a run, -1 retracts one previously asserted. An open session whose runs
    -- grow is re-derived by writing -1 rows for what it had and +1 rows for what it has
    -- now. The delta MV multiplies by sign, so the serving layer absorbs the correction
    -- as two more additive rows. No mutation, no rebuild, no recompute of other sessions.
    sign             Int8 DEFAULT 1,

    -- FOUND LIVE, ABSENT FROM THIS FILE until now. phoenix.session_minute_runs carries this
    -- index; nothing in the repo created it, so it came from an out-of-band ALTER. That made
    -- rebuild_swap.sh a live hazard: it builds the shadow from THIS file and then EXCHANGEs
    -- the tables into phoenix, so the next rebuild would have silently deleted the index from
    -- production, and the shadow verify (closure, overshoot, row counts) would not have
    -- noticed. Declared here so the repo and the server agree and scripts/schema_drift.sh
    -- keeps them that way.
    INDEX idx_run_range (run_start, run_end) TYPE minmax GRANULARITY 4
)
ENGINE = CollapsingMergeTree(sign)
PARTITION BY toYYYYMMDD(run_start)
ORDER BY (video_session_id, run_start, run_end);

-- ORDER BY puts dimensions FIRST and minute LAST, inverting the usual reflex on purpose:
-- a cumulative sum must start at the first minute of the series, never at the start of the
-- queried range, so a time predicate prunes nothing. A dimension filter is the only thing
-- that can prune, so the dimensions have to lead the key.
CREATE TABLE IF NOT EXISTS concurrency_deltas
(
    platform    LowCardinality(String),
    country     LowCardinality(String),
    video_type  LowCardinality(String),
    content_id  Int64,
    app_version LowCardinality(String),
    minute      DateTime,
    delta       Int32
)
ENGINE = SummingMergeTree(delta)
PARTITION BY toYYYYMMDD(minute)
ORDER BY (platform, country, video_type, content_id, app_version, minute);

-- Insert-time MV: every run written becomes exactly two rows, +1 when it starts and -1 in
-- the minute after it ends. Additive, so a late run or a re-derived one is just more rows.
-- GROUP BY is absent by design: the SummingMergeTree collapses on its ORDER BY, which the
-- SELECT matches column for column.
CREATE MATERIALIZED VIEW IF NOT EXISTS concurrency_deltas_mv TO concurrency_deltas AS
SELECT
    platform,
    country,
    video_type,
    content_id,
    app_version,
    d.1 AS minute,
    d.2 * sign AS delta      -- sign = -1 retracts the pair this run contributed before
FROM session_minute_runs
ARRAY JOIN [(run_start, 1), (run_end + INTERVAL 1 MINUTE, -1)] AS d;
