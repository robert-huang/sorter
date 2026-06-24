-- Visit marker: expandCharacterMedia ran for this character_id. Adjacency
-- lives in media_character / character_voice_actor — not in this table.
CREATE TABLE character_media_expansion (
  character_id    INTEGER NOT NULL PRIMARY KEY REFERENCES character(id) ON DELETE CASCADE,
  fetched_at      INTEGER NOT NULL
);
