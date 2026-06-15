/**
 * AniList API helpers for Anime-to-Anime setup (search, load by id, random pick).
 */

import type { AnilistImportContext } from './context';
import { pickRandomAnimeFromUserListCache } from './graphQueries';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
import { mapMediaRow } from './mappers';
import {
  buildAnimeBrowsePageQuery,
  buildAnimeByIdQuery,
  buildAnimePageCountQuery,
  buildAnimeSearchQuery,
} from './queries';
import {
  getAnilistUserByName,
  getListedMediaCount,
  type AnilistUserSummary,
} from './readQueries';
import { runAnilistImport } from './runners';
import type {
  AnilistAnimeByIdResponse,
  AnilistAnimePageCountResponse,
  AnilistAnimeSearchResponse,
  AnilistMediaGql,
  MediaRow,
} from './types';

async function upsertMedia(ctx: AnilistImportContext, media: AnilistMediaGql): Promise<MediaRow> {
  const row = mapMediaRow(media, ctx.now());
  await ctx.db.execBatch([{ sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(row) }]);
  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }
  return row;
}

export async function fetchAnimeById(
  ctx: AnilistImportContext,
  id: number,
): Promise<MediaRow | null> {
  const response = await ctx.executeQuery<AnilistAnimeByIdResponse>(buildAnimeByIdQuery(), {
    id,
  });
  if (!response?.Media || response.Media.type !== 'ANIME') {
    return null;
  }
  return upsertMedia(ctx, response.Media);
}

export async function searchAnimeFromApi(
  ctx: AnilistImportContext,
  query: string,
  perPage = 10,
): Promise<MediaRow[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const response = await ctx.executeQuery<AnilistAnimeSearchResponse>(buildAnimeSearchQuery(), {
    search: trimmed,
    page: 1,
    perPage,
  });
  const media = response?.Page?.media ?? [];
  const rows: MediaRow[] = [];
  for (const item of media) {
    if (item.type !== 'ANIME') {
      continue;
    }
    rows.push(await upsertMedia(ctx, item));
  }
  return rows;
}

export async function pickRandomAnimeFromApi(
  ctx: AnilistImportContext,
): Promise<MediaRow | null> {
  const countResponse = await ctx.executeQuery<AnilistAnimePageCountResponse>(
    buildAnimePageCountQuery(),
    {},
  );
  const total = countResponse?.Page?.pageInfo?.total ?? 0;
  if (total <= 0) {
    return null;
  }

  const perPage = 50;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const page = Math.floor(Math.random() * lastPage) + 1;

  const pageResponse = await ctx.executeQuery<AnilistAnimeSearchResponse>(
    buildAnimeBrowsePageQuery(),
    { page, perPage },
  );
  const candidates = (pageResponse?.Page?.media ?? []).filter((m) => m.type === 'ANIME');
  if (candidates.length === 0) {
    return null;
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  return upsertMedia(ctx, pick);
}

export interface UserListRandomPick {
  /** The chosen anime, or null when the user has no eligible entry. */
  media: MediaRow | null;
  /** Resolved AniList user, or null when the handle didn't resolve. */
  user: AnilistUserSummary | null;
  /** True when this call hit the network to (re)fetch the list. */
  fetched: boolean;
}

export interface PickRandomAnimeFromUserListOptions {
  /** Re-fetch the list from AniList before picking (the right-click action). */
  forceRefresh?: boolean;
  /** Exclude PLANNING entries so only started/finished anime are eligible. */
  excludePlanning?: boolean;
}

/**
 * Pick a random anime from a named user's AniList list.
 *
 * Cache-first: when the user already has a cached anime list and
 * `forceRefresh` is false, this picks straight from the local DB with
 * no network call. Otherwise (nothing cached, or an explicit refresh)
 * it runs the same list import the START screen uses — populating
 * `anilist_user`, `media`, and `media_list_entry` into the shared cache
 * — then picks from the freshened rows.
 *
 * The importer's `AnilistUnknownUserError` / `AnilistScrapeLockHeldError`
 * propagate so the caller can map them to friendly messages.
 */
export async function pickRandomAnimeFromUserList(
  ctx: AnilistImportContext,
  username: string,
  options: PickRandomAnimeFromUserListOptions = {},
): Promise<UserListRandomPick> {
  const handle = username.trim();
  if (!handle) {
    return { media: null, user: null, fetched: false };
  }

  let user = await getAnilistUserByName(ctx.db, handle);
  const cachedCount = user ? await getListedMediaCount(ctx.db, user.id, 'ANIME') : 0;

  let fetched = false;
  if (options.forceRefresh || cachedCount === 0) {
    await runAnilistImport(handle, 'ANIME');
    fetched = true;
    // Re-resolve: a first-ever import is what creates the anilist_user row.
    user = await getAnilistUserByName(ctx.db, handle);
  }

  if (!user) {
    return { media: null, user: null, fetched };
  }

  const media = await pickRandomAnimeFromUserListCache(ctx.db, user.id, {
    excludePlanning: options.excludePlanning,
  });
  return { media, user, fetched };
}
