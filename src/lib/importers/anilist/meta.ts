/**
 * Helpers for the `_meta` table — the per-DB key/value bag the migration
 * runner already created. AniList uses it for "last full refresh"
 * timestamps (scoped per user) and per-type favourites refresh stamps
 * (also scoped per user).
 *
 * Key conventions (per AniList plan §B):
 *   last_full_refresh:<USER_ID>:<TYPE>           epoch_ms — bumped on list-import completion
 *   last_favourites_refresh:<USER_ID>:<TYPE>     epoch_ms — bumped on per-type fav refresh
 *
 * <USER_ID> is the AniList User.id (number, stable across renames).
 * <TYPE> for list refresh is 'ANIME' | 'MANGA'.
 * <TYPE> for favourites is 'ANIME' | 'MANGA' | 'CHARACTERS' | 'STAFF' | 'STUDIOS'.
 *
 * Per-user scoping matters because the DB now holds multiple users'
 * lists. If two users in the same DB share the same key, refreshing
 * one would shadow the other's "stale" indicator and the UI would
 * stop nagging for a refresh that's actually needed.
 *
 * The list importer used to write `last_completed_page:<TYPE>` as a
 * resume checkpoint, but page-level checkpoints aren't safe for
 * `UPDATED_TIME_DESC`-sorted lists (a newly-edited entry shifts every
 * later entry down a slot). The importer now wipe-and-rebuilds on every
 * run, so the checkpoint key + its read/clear helpers were removed.
 */

import type { AnilistDbExecutor } from './context';
import type { AnilistFavouriteType, AnilistMediaType } from './types';

// (type-only import from context.ts is erased — no runtime circular dep)

export type MetaWriteStatement = { sql: string; params?: Array<string | number | null> };

export function lastFullRefreshKey(anilistUserId: number, type: AnilistMediaType): string {
  return `last_full_refresh:${anilistUserId}:${type}`;
}

export function lastFavouritesRefreshKey(
  anilistUserId: number,
  type: AnilistFavouriteType,
): string {
  return `last_favourites_refresh:${anilistUserId}:${type}`;
}

/**
 * Build the UPSERT statement for setting a `_meta` value. Returned as a
 * statement object (not executed) so importers can include it in the same
 * batched transaction as their data writes.
 */
export function buildSetMetaStmt(key: string, value: string | number): MetaWriteStatement {
  return {
    sql: `INSERT INTO _meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    params: [key, String(value)],
  };
}

/** Convenience: write a single `_meta` value via its own statement. */
export async function setMeta(
  db: AnilistDbExecutor,
  key: string,
  value: string | number,
): Promise<void> {
  const stmt = buildSetMetaStmt(key, value);
  await db.exec(stmt.sql, stmt.params);
}
