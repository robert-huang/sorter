-- Graph junction rows are local-only, so their expansion markers must be
-- local-only too. Older builds merged markers without their corresponding
-- rows. Invalidate only marker sections with no local graph evidence so they
-- are repaired once on demand; valid empty results will then be marked again.

UPDATE media_cast_expansion
   SET characters_fetched_at = NULL,
       characters_complete = 0
 WHERE characters_complete = 1
   AND NOT EXISTS (
     SELECT 1
       FROM media_character mc
      WHERE mc.media_id = media_cast_expansion.media_id
   );

UPDATE media_cast_expansion
   SET staff_fetched_at = NULL,
       staff_complete = 0
 WHERE staff_complete = 1
   AND NOT EXISTS (
     SELECT 1
       FROM media_staff ms
      WHERE ms.media_id = media_cast_expansion.media_id
   );

DELETE FROM staff_filmography_expansion
 WHERE NOT EXISTS (
         SELECT 1
           FROM character_voice_actor cva
          WHERE cva.staff_id = staff_filmography_expansion.staff_id
       )
   AND NOT EXISTS (
         SELECT 1
           FROM media_staff ms
          WHERE ms.staff_id = staff_filmography_expansion.staff_id
       );

DELETE FROM character_media_expansion
 WHERE NOT EXISTS (
   SELECT 1
     FROM media_character mc
    WHERE mc.character_id = character_media_expansion.character_id
 );
