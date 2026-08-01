-- raw_events -> foreground_intervals (batch path)
--
-- The state machine itself lives in the event_state view (sql/schema/event_state.sql), so
-- the batch and incremental paths cannot drift apart. This file is only about turning
-- classified events into intervals.
--
-- Parameters: tolerance_s, pause_inactive.
--
-- Needs per-session ordering, so it cannot be an insert-time MV: an MV sees one block and
-- would split sessions across insert boundaries, silently.
--
-- Dimensions come from the session's FIRST event and are held constant. 95 of 10,866
-- sessions report more than one platform and 120 more than one user_id, which is dirty data
-- rather than roaming. Holding them constant keeps session-to-dimension 1:1, without which
-- a session that drifts mid-minute would be counted twice at that minute.
INSERT INTO foreground_intervals
WITH
    {tolerance_s:UInt32} AS tol,
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
            ts,
            if({pause_inactive:UInt8}, is_open, is_open_pause_active) AS is_open,
            -- an event's state holds until the next event, capped by the gap tolerance:
            -- silence longer than the cap is not evidence of watching, whatever the last
            -- state said
            leadInFrame(ts) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_ts,
            least(if(next_ts > ts, next_ts, ts + tol), ts + tol) AS seg_end
        FROM event_state
    )
SELECT
    s.video_session_id,
    d.user_id,
    d.content_id,
    d.platform,
    d.country,
    d.app_version,
    -- LEFT JOIN: an event whose content_id is missing from the catalogue still counts as
    -- watching. Losing it would understate concurrency, the one direction we cannot afford.
    c.video_type,
    toDateTime(s.ts)      AS interval_start,
    toDateTime(s.seg_end) AS interval_end
FROM segments AS s
INNER JOIN dims AS d ON s.video_session_id = d.video_session_id
LEFT JOIN content AS c ON d.content_id = c.content_id
WHERE s.is_open = 1;
