-- Content metadata. 33,464 titles, 3,357 of them referenced by the sample events.
--
-- No dictionary. We tried DICTIONARY + dictGet first, the obvious choice for a table this
-- small, and on Cloud it returned '' for keys that provably exist: dictHas said 0 while an
-- INNER JOIN matched all 3,357 ids, and the same literal answered correctly one query
-- earlier. Dictionaries load per replica, so the answer depended on which node served the
-- query. A JOIN against 33K rows costs nothing and is deterministic.

CREATE TABLE IF NOT EXISTS content
(
    content_id Int64,
    title      String,
    video_type LowCardinality(String),
    category   LowCardinality(String),
    ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree
ORDER BY content_id;
