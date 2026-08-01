-- ORACLE: brute-force foreground concurrency. Deliberately slow, obviously correct.
-- Everything the serving layer produces is validated against this, and only this.
-- Explodes every active segment into per-minute rows: exactly the approach the problem
-- statement rules out at scale. That is the point. It is the reference, not the product.
--
-- Parameters:
--   tolerance_s      heartbeat gap that ends an interval when nothing else does
--   pause_inactive   1 = paused time is not watching, 0 = paused still counts
--
-- State machine (event-primary, heartbeat gap as the fallback):
--   CLOSE on AppBackgrounded / VideoSessionEnd / VideoError, and on pause when
--     pause_inactive = 1 (pause hides in the `event` column of VideoHeartbeat rows)
--   OPEN  on everything else: VideoSessionStart, VideoPlay, AppForegrounded, resume,
--     and any heartbeat, which is itself proof of life
--   FALLBACK every open segment is capped at tolerance_s, so a dropped AppBackgrounded
--     or a silent client cannot extend an interval indefinitely
WITH
    {tolerance_s:UInt32} AS tol,
    {pause_inactive:UInt8} AS pause_off,
    marked AS
    (
        SELECT
            video_session_id,
            user_id,
            content_id,
            platform,
            country,
            toDateTime(event_timestamp) AS ts,
            multiIf(
                event_type IN ('AppBackgrounded', 'VideoSessionEnd', 'VideoError'), 0,
                pause_off AND event IN ('pause', 'speed-pause', 'AdPause'), 0,
                1) AS is_open
        -- events_src: a view the runner defines. Locally it wraps file() and converts
        -- epoch millis; in the Cloud service it is just raw_events. Same SQL either way.
        FROM events_src
    ),
    segments AS
    (
        SELECT
            video_session_id,
            user_id,
            content_id,
            platform,
            country,
            ts AS seg_start,
            leadInFrame(ts) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_ts,
            -- an open event is active until the next event, capped by the gap tolerance.
            -- next_ts = 0 means last event of the session: it runs to the cap.
            least(if(next_ts > seg_start, next_ts, seg_start + tol), seg_start + tol) AS seg_end,
            is_open
        FROM marked
    )
SELECT
    minute,
    uniqExact(video_session_id) AS concurrent_sessions,
    uniqExact(user_id)          AS concurrent_users
FROM
(
    SELECT
        video_session_id,
        user_id,
        -- half-open [seg_start, seg_end): dur-1 keeps a segment that lands exactly on a
        -- minute boundary from claiming the minute it never entered
        arrayJoin(timeSlots(seg_start, toUInt32(greatest(dateDiff('second', seg_start, seg_end) - 1, 0)), 60)) AS minute
    FROM segments
    WHERE is_open = 1
)
GROUP BY minute
ORDER BY minute;
