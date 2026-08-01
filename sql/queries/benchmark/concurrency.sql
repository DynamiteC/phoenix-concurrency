-- PRODUCTION QUERY. Minute curve plus peak and average for the window, in one result set.
--
-- Every filter is optional: '' means no filter on that dimension, content_id 0 means all.
-- Parameters only, no string building, so the demo app passes user input straight through
-- without being able to alter the statement.
--
--   platform, country, video_type, app_version : String   ('' = all)
--   content_id                                 : Int64    (0  = all)
--   from_ts, to_ts                             : String   (window bounds)
--
-- Columns: minute, concurrency, then peak_concurrency / peak_minute / avg_concurrency
-- repeated on every row, so a dashboard renders the curve and the headline numbers from a
-- single round trip.
--
-- Three things this gets right, each of which is a way to be wrong:
--
-- 1. The cumulative sum starts at the FIRST MINUTE OF THE SERIES, not at from_ts. A session
--    that opened before the window is still watching inside it, and starting the sum at the
--    window would lose it. This is why concurrency_deltas is ordered by dimensions first and
--    minute last: a time predicate cannot prune a cumsum, only a dimension filter can.
-- 2. The window is applied AFTER the sum, and peak is taken after that, so peak belongs to
--    the filtered slice. A stored peak would be right only for the slice it was computed
--    for: unfiltered traffic peaks at 10:56, live content peaks at 10:45.
-- 3. The series is densified before averaging. Deltas exist only at boundary minutes, so
--    an average over the sparse rows would silently over-report by skipping quiet minutes.
WITH filtered AS
(
    SELECT minute, sum(delta) AS d
    FROM concurrency_deltas
    WHERE ({platform:String}    = '' OR platform    = {platform:String})
      AND ({country:String}     = '' OR country     = {country:String})
      AND ({video_type:String}  = '' OR video_type  = {video_type:String})
      AND ({app_version:String} = '' OR app_version = {app_version:String})
      AND ({content_id:Int64}   = 0  OR content_id  = {content_id:Int64})
      -- Isolation from the live stream. Without this the serving side sees August rows the
      -- oracle (which reads the July CSV) cannot, and parity fails with 46 phantom minutes
      -- that are not a pipeline defect but a comparison of two different datasets.
      AND minute < {frozen_before:String}
    GROUP BY minute
),
curve AS
(
    SELECT
        minute,
        toInt64(sum(d) OVER (ORDER BY minute ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS concurrency
    FROM filtered
),
windowed AS
(
    SELECT minute, concurrency
    FROM curve
    WHERE minute >= parseDateTimeBestEffort({from_ts:String})
      AND minute <  parseDateTimeBestEffort({to_ts:String})
    ORDER BY minute ASC
    WITH FILL STEP toIntervalMinute(1) INTERPOLATE (concurrency AS concurrency)
)
SELECT
    minute,
    concurrency,
    max(concurrency)            OVER () AS peak_concurrency,
    argMax(minute, concurrency) OVER () AS peak_minute,
    -- round() outside the window: ClickHouse parses round(avg(x), 2) OVER () as an
    -- aggregate named round, which does not exist
    round(avg(concurrency)      OVER (), 2) AS avg_concurrency
FROM windowed
ORDER BY minute ASC;
