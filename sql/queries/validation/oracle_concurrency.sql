-- ORACLE: brute-force foreground concurrency. Deliberately slow, obviously correct.
-- Everything the serving layer produces is validated against this, and only this.
-- Explodes every active segment into per-minute rows: exactly the approach the problem
-- statement rules out at scale. That is the point. It is the reference, not the product.
--
-- The classification is written out again here rather than reading the event_state view.
-- A specification that imports the implementation cannot catch the implementation's bugs.
--
-- Parameters:
--   tolerance_s      heartbeat gap that ends an interval when nothing else does
--   pause_inactive   1 = paused time is not watching, 0 = paused still counts
--
-- Three buckets:
--   DEACTIVATING  AppBackgrounded, VideoSessionEnd, VideoError, pause family
--   REACTIVATING  VideoSessionStart, VideoPlay, AppForegrounded, resume family
--   NEUTRAL       every other heartbeat value: carries the previous state forward, and
--                 must never flip it. Treating telemetry as reactivating cancels a pause
--                 at the next buffer-health row.
WITH
    {tolerance_s:UInt32} AS tol,
    {pause_inactive:UInt8} AS pause_off,
    collapsed AS
    (
        -- one row per (session, millisecond); min() skips NULLs, so a decisive event beats
        -- simultaneous telemetry, and a close beats an open at the same instant
        SELECT
            video_session_id,
            any(user_id)    AS user_id,
            any(content_id) AS content_id,
            any(platform)   AS platform,
            any(country)    AS country,
            ts,
            min(cls)        AS cls
        FROM
        (
            SELECT
                video_session_id, user_id, content_id, platform, country,
                event_timestamp AS ts,
                multiIf(
                    event_type IN ('AppBackgrounded', 'VideoSessionEnd', 'VideoError'), 0,
                    pause_off AND event_type = 'VideoHeartbeat'
                        AND event IN ('pause', 'speed-pause', 'AdPause'), 0,
                    event_type IN ('VideoSessionStart', 'VideoPlay', 'AppForegrounded'), 1,
                    event_type = 'VideoHeartbeat'
                        AND event IN ('resume', 'speed-resume', 'AdResume'), 1,
                    NULL) AS cls
            -- events_src: a view the runner defines. Locally it wraps file() and converts
            -- epoch millis; in the service it is raw_events. Same SQL either way.
            FROM events_src
        )
        GROUP BY video_session_id, ts
    ),
    stated AS
    (
        SELECT
            video_session_id, user_id, content_id, platform, country, ts,
            coalesce(argMax(cls, if(cls IS NULL, toDateTime64(0, 3), ts)) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 1) AS is_open
        FROM collapsed
    ),
    segments AS
    (
        SELECT
            video_session_id, user_id, ts AS seg_start, is_open,
            leadInFrame(ts) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_ts,
            least(if(next_ts > seg_start, next_ts, seg_start + tol), seg_start + tol) AS seg_end
        FROM stated
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
        arrayJoin(timeSlots(toDateTime(seg_start),
                            toUInt32(greatest(dateDiff('second', seg_start, seg_end) - 1, 0)),
                            60)) AS minute
    FROM segments
    WHERE is_open = 1
)
GROUP BY minute
ORDER BY minute;
