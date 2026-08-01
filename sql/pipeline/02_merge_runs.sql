-- foreground_intervals -> session_minute_runs
--
-- Collapse each session's intervals into the contiguous minute runs it was active for.
-- Half-open interval_end: a run ending exactly on a minute boundary must not claim the
-- minute it never entered, so the last covered minute is (interval_end - 1 second).
--
-- Writing this table is what fires concurrency_deltas_mv, so the delta rollup is populated
-- as a side effect of this insert, never by a separate pass.
INSERT INTO session_minute_runs
WITH
    per_session AS
    (
        SELECT
            video_session_id,
            any(user_id)     AS user_id,
            any(content_id)  AS content_id,
            any(platform)    AS platform,
            any(country)     AS country,
            any(app_version) AS app_version,
            any(video_type)  AS video_type,
            -- every distinct minute this session was active in, ascending
            arraySort(groupUniqArrayArray(
                timeSlots(interval_start,
                          toUInt32(greatest(dateDiff('second', interval_start, interval_end) - 1, 0)),
                          60)
            )) AS minutes
        FROM foreground_intervals
        GROUP BY video_session_id
    ),
    runs AS
    (
        SELECT
            video_session_id, user_id, content_id, platform, country, app_version, video_type,
            -- split the minute list wherever the step is bigger than one minute
            arrayJoin(arraySplit(
                (m, i) -> (i > 1) AND (m - minutes[i - 1] > 60),
                minutes, arrayEnumerate(minutes))) AS run
        FROM per_session
    )
SELECT
    video_session_id, user_id, content_id, platform, country, app_version, video_type,
    run[1]      AS run_start,
    run[-1]     AS run_end
FROM runs;
