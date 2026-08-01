-- Incremental derivation. Processes only sessions that received events in a window, and
-- corrects what they contributed before instead of rebuilding anything.
--
-- Parameters: from_ts, to_ts (the arrival window), tolerance_s, pause_inactive.
--
-- Two statements, in order:
--   1. retract: write sign = -1 rows for every run those sessions currently assert
--   2. assert:  re-derive them from their full event history and write sign = +1 rows
-- The delta MV turns both into additive rows, so the serving table self-corrects. Other
-- sessions are never read, never rewritten, and the dashboard never sees a gap: the
-- retraction and the assertion land in the same tick.
--
-- Why re-derive a whole session rather than only its new minutes: an arriving heartbeat can
-- extend a run, close one, or bridge two, and a session's event history is ~80 rows on the
-- session-ordered primary key. Cheap, and it removes a whole class of edge cases.

-- The aggregation lives in a subquery on purpose: writing `-1 AS sign` in the same SELECT
-- shadows the table's own `sign` inside HAVING, so `sum(sign)` evaluates the constant and
-- the filter silently matches nothing. That failure is invisible, the insert just writes
-- zero rows, and the serving layer then double-counts every re-derived session.
INSERT INTO session_minute_runs
SELECT
    video_session_id, user_id, content_id, platform, country, app_version, video_type,
    run_start, run_end, -1 AS sign
FROM
(
    SELECT
        video_session_id, user_id, content_id, platform, country, app_version, video_type,
        run_start, run_end
    FROM session_minute_runs
    WHERE video_session_id IN (
        SELECT DISTINCT video_session_id FROM raw_events
        WHERE event_timestamp >= parseDateTimeBestEffort({from_ts:String})
          AND event_timestamp <  parseDateTimeBestEffort({to_ts:String}))
    GROUP BY video_session_id, user_id, content_id, platform, country, app_version, video_type,
             run_start, run_end
    HAVING sum(sign) > 0   -- only retract what is currently asserted
);

INSERT INTO session_minute_runs
WITH
    {tolerance_s:UInt32} AS tol,
    touched AS
    (
        SELECT DISTINCT video_session_id FROM raw_events
        WHERE event_timestamp >= parseDateTimeBestEffort({from_ts:String})
          AND event_timestamp <  parseDateTimeBestEffort({to_ts:String})
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
        WHERE video_session_id IN (SELECT video_session_id FROM touched)
        GROUP BY video_session_id
    ),
    segments AS
    (
        SELECT
            video_session_id,
            ts AS interval_start,
            if({pause_inactive:UInt8}, is_open, is_open_pause_active) AS is_open,
            leadInFrame(ts) OVER (
                PARTITION BY video_session_id ORDER BY ts ASC
                ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_ts,
            least(if(next_ts > ts, next_ts, ts + tol), ts + tol) AS interval_end
        FROM event_state
        WHERE video_session_id IN (SELECT video_session_id FROM touched)
    ),
    per_session AS
    (
        SELECT
            video_session_id,
            arraySort(groupUniqArrayArray(
                timeSlots(toDateTime(interval_start),
                          toUInt32(greatest(dateDiff('second', interval_start, interval_end) - 1, 0)),
                          60))) AS minutes
        FROM segments
        WHERE is_open = 1
        GROUP BY video_session_id
    ),
    runs AS
    (
        SELECT
            video_session_id,
            arrayJoin(arraySplit(
                (m, i) -> (i > 1) AND (m - minutes[i - 1] > 60),
                minutes, arrayEnumerate(minutes))) AS run
        FROM per_session
    )
SELECT
    r.video_session_id,
    d.user_id, d.content_id, d.platform, d.country, d.app_version,
    c.video_type,
    r.run[1]  AS run_start,
    r.run[-1] AS run_end,
    1 AS sign
FROM runs AS r
INNER JOIN dims AS d ON r.video_session_id = d.video_session_id
LEFT JOIN content AS c ON d.content_id = c.content_id;
