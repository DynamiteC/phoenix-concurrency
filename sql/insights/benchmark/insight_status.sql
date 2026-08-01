-- BENCHMARK: how far each insight table has been derived, against how far the raw stream has got.
--
--   frozen_before : String  (isolation, injected by ch.sh)
--
-- The v2 console's header. It exists because the insight layer is refreshed by a job rather than
-- by ingest, so it lags, and a dashboard that shows a lagging number without showing the lag is
-- presenting stale data as current. Every watermark below is reported next to the raw watermark
-- so the gap is on screen rather than inferred.
--
-- THE RAW WATERMARK IS DELIBERATELY UNFROZEN, matching serving/ingest_status.sql: its job is to
-- show the live stream moving. Every insight watermark carries the frozen predicate, because
-- every insight serving query does, and a header claiming a minute the views cannot render would
-- be worse than no header.
--
-- sum(sign) on the Collapsing table and max(version) nowhere: the question here is "how recent is
-- the newest row", which max() answers directly on any engine. Counts are the aggregates each
-- engine maintains, per the counting rules in docs/database_details.md.
SELECT
    (SELECT max(event_timestamp) FROM raw_events)                                                   AS raw_latest,
    (SELECT count()              FROM raw_events)                                                   AS raw_events,

    (SELECT max(session_start)   FROM session_insight_facts WHERE session_start < {frozen_before:String}) AS facts_latest,
    (SELECT uniqExact(video_session_id) FROM session_insight_facts WHERE session_start < {frozen_before:String}) AS facts_sessions,

    (SELECT max(minute)          FROM audience_minute_snapshot WHERE minute < {frozen_before:String}) AS snapshot_latest,
    (SELECT uniqExact(minute)    FROM audience_minute_snapshot WHERE minute < {frozen_before:String}) AS snapshot_minutes,

    (SELECT max(transition_at)   FROM session_state_transitions WHERE transition_at < {frozen_before:String}) AS transitions_latest,
    (SELECT sum(sign)            FROM session_state_transitions WHERE transition_at < {frozen_before:String}) AS transitions_asserted,

    (SELECT max(minute)          FROM playback_health_minute WHERE minute < {frozen_before:String})   AS health_latest,
    (SELECT max(cohort_minute)   FROM content_entry_cohorts  WHERE cohort_minute < {frozen_before:String}) AS cohorts_latest,

    -- These two are expected to be zero until their producers run. Reported rather than hidden:
    -- an empty view with a zero next to it is a pipeline state, an empty view with nothing next to
    -- it is indistinguishable from a broken query.
    (SELECT count()              FROM concurrency_spike_events)                                     AS spike_events,
    (SELECT count()              FROM late_event_audit)                                             AS late_events
-- READ BUDGET. Twelve scalar subqueries, each an aggregate over one table's key column. The
-- ceiling is dominated by session_state_transitions at 1.36M physical rows; the rest are minute
-- and session grain and are small by comparison.
SETTINGS max_rows_to_read = 12000000,
         max_bytes_to_read = 400000000,
         max_execution_time = 30,
         timeout_before_checking_execution_speed = 0;
