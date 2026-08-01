-- Minute-grain concurrency curve from the serving layer. Never touches raw_events.
--
-- Parameters (empty string = no filter on that dimension):
--   platform, country, video_type, app_version, content_id (0 = all)
--   from_ts, to_ts  ISO timestamps bounding the OUTPUT window
--
-- The cumulative sum runs from the first minute of the series, not from from_ts: a session
-- that started before the window is still watching inside it. The range filter is therefore
-- applied AFTER the running total, which is why concurrency_deltas is ordered by dimensions
-- first and minute last. Dimension filters prune; a time filter cannot.
--
-- WITH FILL + INTERPOLATE densifies the series, because deltas only exist at boundary
-- minutes and an average over a sparse series is wrong.
WITH filtered AS
(
    SELECT
        minute,
        sum(delta) AS d
    FROM concurrency_deltas
    WHERE ({platform:String}    = '' OR platform    = {platform:String})
      AND ({country:String}     = '' OR country     = {country:String})
      AND ({video_type:String}  = '' OR video_type  = {video_type:String})
      AND ({app_version:String} = '' OR app_version = {app_version:String})
      AND ({content_id:Int64}   = 0  OR content_id  = {content_id:Int64})
    GROUP BY minute
),
curve AS
(
    SELECT
        minute,
        toInt64(sum(d) OVER (ORDER BY minute ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS concurrency
    FROM filtered
)
SELECT minute, concurrency
FROM curve
WHERE minute >= parseDateTimeBestEffort({from_ts:String})
  AND minute <  parseDateTimeBestEffort({to_ts:String})
ORDER BY minute ASC WITH FILL STEP toIntervalMinute(1) INTERPOLATE (concurrency AS concurrency);
