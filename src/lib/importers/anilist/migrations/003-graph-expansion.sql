-- Graph expansion: production staff junction, split cast/staff timestamps,
-- staff filmography visit marker, franchise relations.

-- Production / staff credits on a show (also populated from Staff.staffMedia
-- during filmography expand).
CREATE TABLE media_staff (
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  staff_id        INTEGER NOT NULL REFERENCES staff(id),
  role            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,
  PRIMARY KEY (media_id, staff_id, role)
);
CREATE INDEX idx_media_staff_staff ON media_staff(staff_id);

-- Split cast vs staff expansion tracking (replaces reliance on a single
-- fetched_at for stale UI and Drive merge).
ALTER TABLE media_cast_expansion ADD COLUMN characters_fetched_at INTEGER;
ALTER TABLE media_cast_expansion ADD COLUMN staff_fetched_at INTEGER;
ALTER TABLE media_cast_expansion ADD COLUMN characters_complete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_cast_expansion ADD COLUMN staff_complete INTEGER NOT NULL DEFAULT 0;

-- Backfill split timestamps from legacy fetched_at.
UPDATE media_cast_expansion
   SET characters_fetched_at = fetched_at,
       staff_fetched_at = fetched_at
 WHERE characters_fetched_at IS NULL;

-- Best-effort completeness for upgraded DBs: if cast rows exist, assume
-- characters were expanded before upgrade (user can refresh for full pages).
UPDATE media_cast_expansion
   SET characters_complete = 1
 WHERE characters_complete = 0
   AND EXISTS (
     SELECT 1 FROM media_character mc
      WHERE mc.media_id = media_cast_expansion.media_id
   );

-- Visit marker: expandStaffFilmography ran for this staff_id. Adjacency
-- lives in media_staff / media_character / CVA — not in this table.
CREATE TABLE staff_filmography_expansion (
  staff_id        INTEGER NOT NULL PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
  fetched_at      INTEGER NOT NULL
);

-- Franchise relations (lazy Media.relations), optional anime-to-anime mode.
CREATE TABLE media_relation (
  from_media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  to_media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  PRIMARY KEY (from_media_id, to_media_id, relation_type)
);
CREATE INDEX idx_media_relation_to ON media_relation(to_media_id);
