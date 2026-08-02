-- Session-independent concurrency: how many distinct USERS are watching, not how many
-- sessions. The problem statement asks for both readings and for the divergence between
-- them, and they are genuinely different questions: one person on a phone and a TV is two
-- sessions and one viewer.
--
-- Deltas cannot be reused from the session rollup, because summing session deltas counts
-- that person twice. A user's runs are therefore merged ACROSS all of their sessions first,
-- so overlapping sessions collapse into one run before any +1 is emitted.
--
-- Dimension attribution: a user is filed under the dimensions of their FIRST run. 7 users of
-- 9,510 watch on more than one platform, and for those a platform filter attributes them to
-- the platform they started on. Keying user runs by dimension instead would make the
-- unfiltered total wrong for exactly those users, which is the worse trade: the unfiltered
-- number is the one on the wall.

CREATE TABLE IF NOT EXISTS user_minute_runs
(
    user_id     String,
    platform    LowCardinality(String),
    country     LowCardinality(String),
    video_type  LowCardinality(String),
    content_id  Int64,
    app_version LowCardinality(String),
    run_start   DateTime,
    run_end     DateTime,
    sign        Int8 DEFAULT 1
)
ENGINE = CollapsingMergeTree(sign)
PARTITION BY toYYYYMMDD(run_start)
ORDER BY (user_id, run_start, run_end);

CREATE TABLE IF NOT EXISTS user_concurrency_deltas
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

CREATE MATERIALIZED VIEW IF NOT EXISTS user_concurrency_deltas_mv TO user_concurrency_deltas AS
SELECT
    platform, country, video_type, content_id, app_version,
    d.1 AS minute,
    d.2 * sign AS delta
FROM user_minute_runs
ARRAY JOIN [(run_start, 1), (run_end + INTERVAL 1 MINUTE, -1)] AS d;
