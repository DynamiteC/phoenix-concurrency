-- INSIGHTS: playback health per minute. "Was the decline technical, or was it the content?"
--
-- THE DENOMINATOR IS DOCUMENTED BECAUSE IT IS A DEFINITION, not a fact. Every rate here is
--
--     rate = <sessions in this state during this minute> / active_sessions in this minute
--
-- where active_sessions is the same concurrent_sessions that audience_minute_snapshot carries
-- and that is gated against the authoritative concurrency_deltas curve. A session in trouble
-- but not currently active contributes to the numerator of nothing. The plan's Phase 8 gate
-- asks for the denominator to be stated outright, so: it is active sessions, not started
-- sessions and not distinct users.
--
-- CORRELATION, NOT CAUSATION, AND THE TABLE CANNOT PROVE OTHERWISE. A concurrency fall next to
-- an error spike is a coincidence in time until somebody shows the affected sessions are the
-- ones that left. This table measures both series per minute and does not claim the link.
-- Establishing it needs session-level linkage, which session_state_transitions is where it
-- would come from.

CREATE TABLE IF NOT EXISTS playback_health_minute
(
    minute      DateTime,
    content_id  Int64,
    platform    LowCardinality(String),
    country     LowCardinality(String),
    app_version LowCardinality(String),
    video_type  LowCardinality(String),

    active_sessions            UInt32,
    video_error_sessions       UInt32,  -- distinct sessions emitting VideoError in this minute
    heartbeat_timeout_sessions UInt32,  -- sessions whose last active interval closed here by silence
    abandoned_sessions         UInt32,  -- sessions with no VideoSessionEnd, last active in this minute

    video_error_rate      Float32,
    heartbeat_timeout_rate Float32,
    abandonment_rate      Float32,

    version    UInt64,
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(minute)
ORDER BY (minute, content_id, platform, country, app_version);

-- recovered_after_error, returned_after_timeout and error_recovery_rate are in the plan and NOT
-- here. All three are questions about what a session did NEXT, which is a transition and not a
-- per-minute count: "recovered" means error then foreground again, and nothing in the current
-- model records that ordering. session_state_transitions is where they belong, and shipping
-- them from a single unvalidated implementation beside three gated columns is the shape of
-- every entry in docs/corrections.md. Marked, not silently dropped.

-- TTL, written and NOT active. See docs/RETENTION.md.
-- TTL minute + INTERVAL 12 MONTH WHERE toDate(minute) >= toDate('2026-08-01')
