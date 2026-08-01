-- raw_events -> foreground_intervals
--
-- Same state machine as the oracle (sql/queries/validation/oracle_concurrency.sql): the
-- oracle is the specification, this is the production path, and they are diffed every run.
--
-- Batch INSERT ... SELECT for now. It needs per-session ordering, so it cannot be an
-- insert-time MV: an MV sees one block and would split sessions across insert boundaries,
-- silently. Making this incremental (watermark, only sessions touched) is phase 3.
--
-- Dimensions are taken from the session's FIRST event and held constant for the session.
-- 95 of 10,866 sessions report more than one platform and 120 more than one user_id, which
-- is dirty data, not roaming. Holding them constant keeps session-to-dimension 1:1, without
-- which a session that drifts mid-minute would be counted twice at that minute.
INSERT INTO foreground_intervals
WITH
    {tolerance_s:UInt32} AS tol,
    {pause_inactive:UInt8} AS pause_off,
    marked AS
    (
        -- One row per (session, second). Clients emit several events in the same
        -- millisecond, and with ties leadInFrame returns an arbitrary tied row, so the
        -- next-event lookup sees the same timestamp and the segment falls through to the
        -- full gap cap. Tie order is not stable, so this made the number
        -- non-deterministic between runs. min(is_open): a close beats an open at the
        -- same instant.
        SELECT
            video_session_id,
            ts,
            min(is_open) AS is_open
        FROM
        (
            SELECT
                video_session_id,
                toDateTime(event_timestamp) AS ts,
                multiIf(
                    event_type IN ('AppBackgrounded', 'VideoSessionEnd', 'VideoError'), 0,
                    pause_off AND event IN ('pause', 'speed-pause', 'AdPause'), 0,
                    1) AS is_open
            FROM raw_events
        )
        GROUP BY video_session_id, ts
    ),
    dims AS
    (
        SELECT
            video_session_id,
            argMin(user_id, event_timestamp)     AS user_id,
            argMin(content_id, event_timestamp)  AS content_id,
            argMin(platform, event_timestamp)    AS platform,
            argMin(country, event_timestamp)     AS country,
            argMin(app_version, event_timestamp) AS app_version
        FROM raw_events
        GROUP BY video_session_id
    ),
    segments AS
    (
        SELECT
            video_session_id,
            ts AS interval_start,
            leadInFrame(ts) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_ts,
            least(if(next_ts > ts, next_ts, ts + tol), ts + tol) AS interval_end,
            is_open
        FROM marked
    )
SELECT
    s.video_session_id,
    d.user_id,
    d.content_id,
    d.platform,
    d.country,
    d.app_version,
    -- LEFT JOIN: an event whose content_id is missing from the catalogue still counts as
    -- watching. Losing it would understate concurrency, which is the one direction we
    -- cannot afford to be wrong in.
    c.video_type,
    s.interval_start,
    s.interval_end
FROM segments AS s
INNER JOIN dims AS d ON s.video_session_id = d.video_session_id
LEFT JOIN content AS c ON d.content_id = c.content_id
WHERE s.is_open = 1;
