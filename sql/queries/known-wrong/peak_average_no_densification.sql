-- KNOWN WRONG. RETAINED AS A REGRESSION FIXTURE. DO NOT SERVE THIS.
--
-- Measured full-day average on 2026-07-26: 246.98, against a true 88.20. 2.8x over.
--
-- The defect: no densification at all. The average is taken straight over the sparse delta
-- boundary rows, so the denominator is the number of minutes in which concurrency CHANGED
-- rather than the number of minutes in the range. Same class as
-- concurrency_unbounded_fill.sql and a worse instance of it.
--
-- Peak returns 2,829 here, correctly. That is exactly why this survived undetected: peak can
-- only occur at a delta boundary, so it is immune to sparseness. Average is not. Nor is p95,
-- which the dashboard shipped over the sparse series for the same reason.
--
-- Kept as a fixture per TASK.md 3.1. Corrected query: sql/queries/serving/peak_average.sql.

-- Peak and average concurrency over a range, at any time grain, with dimension filters.
--
-- Peak is computed AFTER filtering, never read from a stored maximum: an Android slice and
-- an Android+india slice peak at different minutes inside the same range, so a precomputed
-- peak is only ever right for the slice it was computed for.
--
-- Grain applies to the reporting bucket, not to the concurrency itself. Concurrency is
-- always measured per minute; an hour's peak is the maximum of its minutes and an hour's
-- average is the mean of its minutes. Rolling them up any other way answers a different
-- question.
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
)
SELECT
    -- grain_s: 60 minute, 3600 hour, 86400 day
    toStartOfInterval(minute, toIntervalSecond({grain_s:UInt32})) AS bucket,
    max(concurrency)             AS peak_concurrency,
    argMax(minute, concurrency)  AS peak_minute,
    round(avg(concurrency), 2)   AS avg_concurrency
FROM curve
WHERE minute >= parseDateTimeBestEffort({from_ts:String})
  AND minute <  parseDateTimeBestEffort({to_ts:String})
GROUP BY bucket
ORDER BY bucket;
