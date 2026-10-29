-- AniList `idMal`, used to merge MyAnimeList list entries onto AniList media.
-- `id_mal_fetched_at` NULL means never fetched (stub row or pre-014 import);
-- distinct from `id_mal IS NULL`, which can be the genuine AniList value.
ALTER TABLE media ADD COLUMN id_mal INTEGER;
ALTER TABLE media ADD COLUMN id_mal_fetched_at INTEGER;
CREATE INDEX media_id_mal ON media(id_mal);
