-- Per-seed marker: relations for this media id were fetched at `fetched_at`.
-- Mirrors staff_filmography_expansion / character_media_expansion. Needed
-- because zero media_relation rows is a VALID result (a standalone show with
-- no adaptations) — without a marker, "no edges for id X" is ambiguous
-- (never fetched vs. genuinely empty) and the tools would re-fetch forever.
CREATE TABLE media_relations_expansion (
  media_id    INTEGER NOT NULL PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  fetched_at  INTEGER NOT NULL
);

-- Backfill markers for edges already present from prior A2A use, so the first
-- tools Compare doesn't treat them as uncached and re-fetch. Use the media
-- row's fetched_at as the freshness proxy (the media FK guarantees it exists).
INSERT OR IGNORE INTO media_relations_expansion (media_id, fetched_at)
SELECT DISTINCT mr.from_media_id, m.fetched_at
FROM media_relation mr
JOIN media m ON m.id = mr.from_media_id;
