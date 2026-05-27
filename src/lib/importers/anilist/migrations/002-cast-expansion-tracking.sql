-- Track per-media cast-expansion attempts.
--
-- A row exists iff `expandAnilistMediaDetail` has successfully fetched
-- and committed the cast for `media_id` at least once, even when the
-- response produced ZERO `character_voice_actor` rows. v1 inferred
-- "cast cached" from CVA-row presence, which silently misclassified
-- every legitimately-empty response as still-uncached:
--
--   * Manga entries (AniList has no VAs for manga at all).
--   * Anime with no Japanese VAs (Korean / Chinese productions etc.).
--   * Shows AniList returns with zero character edges.
--
-- The VoiceActorChip's "X/Y cached" counter + the "Fetch cast for N
-- shows" bulk-expand button both consumed that flawed signal, so the
-- counter would stall and the button would re-fetch the same shows
-- forever — every retry succeeding, none changing the counter.
--
-- `language` records which `voiceActors(language:)` filter was applied,
-- so a future per-language refresh ("now also fetch ENGLISH") can
-- detect that the existing row was for a different language and re-
-- expand without losing the JAPANESE marker. v1 default = JAPANESE.
CREATE TABLE media_cast_expansion (
  media_id   INTEGER NOT NULL PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  language   TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Backfill from existing CVA rows so users upgrading from v1 don't
-- see their already-expanded shows revert to "uncached" on first load
-- after the migration.
--
-- v1 only ever wrote 'JAPANESE' as the CVA `language`, so picking
-- MIN(language) per media is a no-op disambiguation — it just ensures
-- the schema-level NOT NULL is satisfied even if a future v2 row had
-- mixed languages before the upgrade ran.
--
-- fetched_at = 0 because we no longer have the real per-media expansion
-- timestamp; the only consumer (chip's cached check) only tests for row
-- presence. The Drive-sync merge uses fetched_at to pick the newer row
-- when two devices have both expanded the same media — older devices
-- carrying the backfilled 0 will lose to any device that ran a real
-- expansion after the migration, which is exactly what we want.
INSERT OR IGNORE INTO media_cast_expansion (media_id, language, fetched_at)
SELECT media_id, MIN(language), 0
FROM character_voice_actor
GROUP BY media_id;
