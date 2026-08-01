-- SERVING: sessions that are still open as of a watermark, and how much of their counted
-- time is provisional.
--
--   as_of         : String  (the watermark to evaluate against)
--   tolerance_s   : UInt32  (gap tolerance, 90 to match the pipeline)
--   frozen_before : String  (isolation, injected by ch.sh)
--
-- This answers problem-statement question 5, "how do you handle sessions that are still open,
-- whose active ranges keep growing as new heartbeats arrive", from the serving side. The
-- pipeline side of that answer is retraction, and the proof it works is
-- evidence/open_session_update.
--
-- WHAT "OPEN" MEANS HERE, because the word is ambiguous and the ambiguity matters:
--
--   a session with no VideoSessionEnd, whose last event is at or before the watermark, and
--   which is still inside the gap tolerance at the watermark.
--
-- The third clause is what stops an abandoned session being counted forever. A client that
-- stopped emitting an hour ago is not open, it is gone; it simply never said so. The
-- tolerance is the only thing that distinguishes those two cases, because AppBackgrounded is
-- explicitly not a guaranteed event.
--
-- PROVISIONAL TAIL is the part a reader should look at. Every open session is currently
-- counted through last_event + tolerance, and every one of those seconds may be retracted
-- when the next heartbeat arrives and reveals the session was paused, backgrounded, or
-- finished. It is the size of the answer that is still allowed to change, which is a number
-- worth putting on a dashboard next to a live concurrency figure rather than hiding.
WITH
    parseDateTimeBestEffort({as_of:String}) AS watermark,
    toIntervalSecond({tolerance_s:UInt32})  AS tol,
    per_session AS
    (
        SELECT
            video_session_id,
            argMin(user_id,     event_timestamp) AS user_id,
            argMin(platform,    event_timestamp) AS platform,
            argMin(country,     event_timestamp) AS country,
            argMin(content_id,  event_timestamp) AS content_id,
            max(event_timestamp)                 AS last_event,
            -- countIf rather than a join back: the close events are in the same scan.
            countIf(event_type = 'VideoSessionEnd') AS ends,
            countIf(event_type = 'AppBackgrounded') AS backgrounds
        FROM raw_events
        WHERE event_timestamp <= watermark
          AND event_timestamp <  {frozen_before:String}
        GROUP BY video_session_id
    )
SELECT
    video_session_id,
    user_id,
    platform,
    country,
    content_id,
    last_event,
    -- How far the current answer extends this session beyond its last known event.
    toDateTime(last_event) + tol                                   AS counted_until,
    dateDiff('second', watermark, toDateTime(last_event) + tol)    AS provisional_seconds,
    backgrounds
FROM per_session
WHERE ends = 0
  AND toDateTime(last_event) + tol > watermark
ORDER BY provisional_seconds DESC, video_session_id
-- READ BUDGET at 3x measured, same policy as the other serving queries. Note the scale
-- difference and why it is expected: this is the ONE serving query that reads raw_events
-- rather than the delta table, because "which sessions are open right now" is a question
-- about events, not about a pre-aggregated curve. 905,558 rows and 132 MiB against the
-- curve queries' 26,904 rows and 210 KiB.
--
-- That is the honest cost of the question and it is why this query is not on the dashboard
-- refresh path. It is a drill-down: run it when someone asks what is still open, not every
-- two seconds behind a live chart.
SETTINGS max_rows_to_read = 2716674,
         max_bytes_to_read = 415749357;
