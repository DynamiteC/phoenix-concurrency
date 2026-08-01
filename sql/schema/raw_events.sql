-- Raw append-only event stream. Source of truth, never read by dashboards.
--
-- event_timestamp / session_start_epoch arrive as epoch MILLIseconds (Int64) in the CSV.
-- We keep them as DateTime64(3) so every downstream expression is time-typed.
--
-- ORDER BY: low -> high cardinality, time last, but session first because every
-- derivation is per-session (the state machine partitions by video_session_id).
-- Reading one session's events must not scatter across granules.

CREATE TABLE IF NOT EXISTS raw_events
(
    video_session_id    String,
    user_id             String,
    content_id          Int64,
    event_type          LowCardinality(String),
    event               LowCardinality(String),
    event_timestamp     DateTime64(3),
    platform            LowCardinality(String),
    app_version         LowCardinality(String),
    country             LowCardinality(String),
    audio_language      LowCardinality(String),
    subtitle_language   LowCardinality(String),
    player_version      LowCardinality(String),
    session_start_epoch DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(event_timestamp)
ORDER BY (video_session_id, event_timestamp);

-- Landing table matching the CSV exactly (epoch millis as Int64), so `load.sh` is a
-- straight INSERT with no client-side transform. An MV converts into raw_events.
CREATE TABLE IF NOT EXISTS raw_events_landing
(
    content_id          Int64,
    video_session_id    String,
    user_id             String,
    event_type          LowCardinality(String),
    event               LowCardinality(String),
    event_timestamp     Int64,
    platform            LowCardinality(String),
    app_version         LowCardinality(String),
    country             LowCardinality(String),
    audio_language      LowCardinality(String),
    subtitle_language   LowCardinality(String),
    player_version      LowCardinality(String),
    session_start_epoch Int64
)
ENGINE = Null;   -- ponytail: pure pass-through, the MV below is the only consumer

CREATE MATERIALIZED VIEW IF NOT EXISTS raw_events_mv TO raw_events AS
SELECT
    video_session_id, user_id, content_id, event_type, event,
    fromUnixTimestamp64Milli(event_timestamp)     AS event_timestamp,
    platform, app_version, country, audio_language, subtitle_language, player_version,
    fromUnixTimestamp64Milli(session_start_epoch) AS session_start_epoch
FROM raw_events_landing;
