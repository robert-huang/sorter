-- Per-media theme song cache (Jikan/MAL + AniPlaylist merge). Marker row
-- distinguishes "never fetched" from "fetched, zero songs".
CREATE TABLE media_theme_songs_expansion (
  media_id     INTEGER NOT NULL PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  mal_id       INTEGER,
  fetched_at   INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
