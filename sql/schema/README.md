# schema

One DDL file per table, named after the table: `raw_events.sql`, `content.sql`, ...
Each file is idempotent (`CREATE TABLE IF NOT EXISTS`) so anyone can re-run the whole dir.
Ordering key choices get a comment saying why, and a line in `docs/assumptions.md`.
