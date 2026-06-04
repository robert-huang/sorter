import type { Database } from '@sqlite.org/sqlite-wasm';

/**
 * After generic row-level merge, reconcile `media_cast_expansion` split
 * timestamps and completeness flags (newer per-column wins; OR flags).
 */
export function mergeMediaCastExpansionSplit(localDb: Database): void {
  const tableExists = localDb.selectValue(
    `SELECT 1 FROM remote.sqlite_master
      WHERE type = 'table' AND name = 'media_cast_expansion' LIMIT 1`,
  );
  if (!tableExists) {
    return;
  }

  const hasSplitCols = localDb.selectValue(
    `SELECT COUNT(*) FROM pragma_table_info('media_cast_expansion')
      WHERE name = 'characters_fetched_at'`,
  );
  if (!hasSplitCols) {
    return;
  }

  localDb.exec(`
    INSERT OR IGNORE INTO media_cast_expansion (media_id, language, fetched_at)
    SELECT media_id, language, fetched_at FROM remote.media_cast_expansion;
  `);

  localDb.exec(`
    UPDATE media_cast_expansion SET
      characters_fetched_at = CASE
        WHEN remote.characters_fetched_at IS NOT NULL
         AND (media_cast_expansion.characters_fetched_at IS NULL
              OR remote.characters_fetched_at > media_cast_expansion.characters_fetched_at)
        THEN remote.characters_fetched_at
        ELSE media_cast_expansion.characters_fetched_at
      END,
      staff_fetched_at = CASE
        WHEN remote.staff_fetched_at IS NOT NULL
         AND (media_cast_expansion.staff_fetched_at IS NULL
              OR remote.staff_fetched_at > media_cast_expansion.staff_fetched_at)
        THEN remote.staff_fetched_at
        ELSE media_cast_expansion.staff_fetched_at
      END,
      characters_complete = MAX(
        COALESCE(media_cast_expansion.characters_complete, 0),
        COALESCE(remote.characters_complete, 0)
      ),
      staff_complete = MAX(
        COALESCE(media_cast_expansion.staff_complete, 0),
        COALESCE(remote.staff_complete, 0)
      ),
      fetched_at = MAX(
        COALESCE(media_cast_expansion.fetched_at, 0),
        COALESCE(remote.fetched_at, 0)
      ),
      language = CASE
        WHEN remote.fetched_at IS NOT NULL
         AND remote.fetched_at >= COALESCE(media_cast_expansion.fetched_at, 0)
        THEN remote.language
        ELSE media_cast_expansion.language
      END
    FROM remote.media_cast_expansion AS remote
    WHERE media_cast_expansion.media_id = remote.media_id;
  `);
}
