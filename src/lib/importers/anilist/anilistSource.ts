import { registerSource, type SourceDescriptor } from '../../db/source-registry';
import migration001 from './migrations/001-init.sql?raw';

export const ANILIST_SOURCE_ID = 'anilist';

/**
 * AniList source descriptor — migrations + the row-level merge spec consumed
 * by `src/lib/db/merge.ts`.
 *
 * Merge spec design notes (v1):
 *
 *   - **Source-owned metadata** (anilist_user, media, studio, tag, character,
 *     staff) merges on `fetched_at`. Both `fetched_at` and `updated_at`
 *     exist on media / character / staff but the importer upserts them
 *     together, so the two timestamps are effectively equal per row.
 *     `fetched_at` is the cross-source convention (see
 *     `src/lib/db/testSource.ts`). `anilist_user` is in here so two
 *     devices that both imported the same user converge on the latest
 *     fetched name (matters when the user has renamed on AniList).
 *
 *   - **User-data tables** (media_list_entry) merge on `updated_at` to
 *     match the test-source convention. PK is composite
 *     `(anilist_user_id, media_id)` so multiple users' rows coexist in
 *     the same DB and merge independently — your friend's entries
 *     don't fight your own.
 *
 *   - **Junctions** (`media_studio`, `media_tag`, `media_character`,
 *     `character_voice_actor`) are deliberately NOT in the merge spec — they
 *     carry no independent timestamp and are rebuilt transactionally on
 *     every parent refresh. CASCADE FKs from the parent metadata tables keep
 *     them consistent after row-level merge.
 *
 *   - **Favourites** (`media_favourite`, `character_favourite`,
 *     `staff_favourite`, `studio_favourite`) are also NOT in the merge spec.
 *     They carry `fetched_at` for "row last touched" diagnostics, but row-
 *     level merge would resurrect favourites the user has *removed* on
 *     AniList (the wipe-and-rebuild contract drops the row on one device;
 *     row-level merge from a stale snapshot would re-introduce it). Same
 *     applies to `custom_list` and `media_custom_list_membership` —
 *     both are wipe-and-rebuild on per-(user, type) import. v1
 *     trade-off: per-user mutable data only syncs via wipe-and-rebuild
 *     on the device that runs the refresh — multi-device drift means
 *     the user must re-refresh on whichever device has the canonical view.
 *     If this becomes painful, options are (a) "favourites table snapshot"
 *     merge (last writer of the per-type fetch wins the whole table), or
 *     (b) AniList OAuth so favourites can be sourced live without local
 *     truth. See AniList plan §B "rebuild semantics" for context.
 */
export const anilistSourceDescriptor: SourceDescriptor = {
  id: ANILIST_SOURCE_ID,
  migrations: [{ version: 1, sql: migration001 }],
  merge: {
    metadataTables: [
      { name: 'anilist_user', pk: ['id'], timestampCol: 'fetched_at' },
      { name: 'media', pk: ['id'], timestampCol: 'fetched_at' },
      { name: 'studio', pk: ['id'], timestampCol: 'fetched_at' },
      { name: 'tag', pk: ['name'], timestampCol: 'fetched_at' },
      { name: 'character', pk: ['id'], timestampCol: 'fetched_at' },
      { name: 'staff', pk: ['id'], timestampCol: 'fetched_at' },
    ],
    userDataTables: [
      {
        name: 'media_list_entry',
        pk: ['anilist_user_id', 'media_id'],
        timestampCol: 'updated_at',
      },
    ],
  },
};

let registered = false;

/** Registers the AniList source (idempotent). */
export function ensureAnilistSourceRegistered(): void {
  if (registered) {
    return;
  }
  registerSource(anilistSourceDescriptor);
  registered = true;
}
