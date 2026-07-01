-- Marks that `source(version: 3)` was imported for this row. NULL means we
-- have never fetched adaptation source (stub row, pre-v3 import, or clobber).
-- Distinct from `source IS NULL`, which can be the genuine AniList value.
ALTER TABLE media ADD COLUMN source_fetched_at INTEGER;
