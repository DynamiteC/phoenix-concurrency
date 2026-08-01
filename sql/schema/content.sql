-- Content metadata. 3,357 distinct content_ids in the sample, ~33K titles in the
-- full file: small enough to live in memory, so it is a dictionary, not a join.
-- Enrichment at insert time via dictGet costs nothing and keeps video_type/category
-- available as ordinary filter dimensions in the serving layer.

CREATE TABLE IF NOT EXISTS content
(
    content_id Int64,
    title      String,
    video_type LowCardinality(String),
    category   LowCardinality(String)
)
ENGINE = ReplacingMergeTree
ORDER BY content_id;

CREATE DICTIONARY IF NOT EXISTS content_dict
(
    content_id Int64,
    title      String,
    video_type String,
    category   String
)
PRIMARY KEY content_id
SOURCE(CLICKHOUSE(TABLE 'content'))
LAYOUT(HASHED())
LIFETIME(MIN 300 MAX 600);
