import {
  ensureUserAnimeListFresh,
  ensureUserMangaListFresh,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  getFavouriteEntityIdsForUsername,
  getListEntriesByMediaIds,
  getListedMedia,
} from '../../lib/importers/anilist/readQueries';
import type { MediaRow } from '../../lib/importers/anilist/types';
import type { ComparisonEntry, ComparisonMediaType } from './scoreComparisonLogic';

export type LoadedComparisonList = {
  /** Canonical AniList name. */
  name: string;
  entries: Map<number, ComparisonEntry>;
  media: MediaRow[];
  favouriteMediaIds: Set<number>;
};

/**
 * Load one user's list from the source DB, importing from AniList only
 * when it was never cached (or `forceRefresh` is set). Null = unknown user.
 */
export async function loadComparisonList(
  username: string,
  mediaType: ComparisonMediaType,
  options?: { forceRefresh?: boolean; signal?: AbortSignal },
): Promise<LoadedComparisonList | null> {
  const ensure = mediaType === 'MANGA' ? ensureUserMangaListFresh : ensureUserAnimeListFresh;
  const user = await ensure(username, options);
  if (!user) return null;
  const { db } = getToolsImportContext();
  const media = await getListedMedia(db, user.id, mediaType);
  const [rows, favourites] = await Promise.all([
    getListEntriesByMediaIds(
      db,
      user.id,
      media.map((m) => m.id),
    ),
    getFavouriteEntityIdsForUsername(db, user.name),
  ]);
  const entries = new Map<number, ComparisonEntry>();
  for (const [mediaId, row] of rows) {
    entries.set(mediaId, { status: row.status, score: row.score ?? 0 });
  }
  return { name: user.name, entries, media, favouriteMediaIds: favourites.mediaIds };
}
