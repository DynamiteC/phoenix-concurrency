-- SERVING: distinct filter values for the four dimensions the serving layer is keyed on.
--
--   frozen_before : String  (isolation, injected by ch.sh)
--
-- Reads concurrency_deltas rather than raw_events: the delta table is already deduplicated to
-- one row per dimension tuple per minute and is tiny, so a dropdown costs a scan of 27K rows
-- instead of the 905K-row event table.
--
-- The frozen predicate is not cosmetic here. Live ingest reaches concurrency_deltas (measured
-- this session), so without it a dimension value that appears only in the live stream would
-- show up in the filter rail while the curve query, which IS frozen, returns an empty series
-- for it. A filter that selects nothing looks like a broken dashboard.
SELECT 'platform'    AS dim, platform    AS value FROM concurrency_deltas WHERE minute < {frozen_before:String} GROUP BY 1, 2
UNION ALL
SELECT 'country'     AS dim, country     AS value FROM concurrency_deltas WHERE minute < {frozen_before:String} GROUP BY 1, 2
UNION ALL
SELECT 'video_type'  AS dim, video_type  AS value FROM concurrency_deltas WHERE minute < {frozen_before:String} GROUP BY 1, 2
UNION ALL
SELECT 'app_version' AS dim, app_version AS value FROM concurrency_deltas WHERE minute < {frozen_before:String} GROUP BY 1, 2
ORDER BY dim, value
-- READ BUDGET, same contract as peak_average.sql: four full scans of the delta table is the
-- worst shape by construction (no dimension leads all four). Measured 4 x 30,662 rows on the
-- frozen slice; ceilings are 3x that. Recalibrate with scripts/bench.sh.
SETTINGS max_rows_to_read = 367944,
         max_bytes_to_read = 3400000;
