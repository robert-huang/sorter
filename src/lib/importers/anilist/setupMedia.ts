/**
 * AniList API helpers for Anime-to-Anime setup (search, load by id, random pick).
 */

import type { AnilistImportContext } from './context';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
import { mapMediaRow } from './mappers';
import {
  buildAnimeBrowsePageQuery,
  buildAnimeByIdQuery,
  buildAnimePageCountQuery,
  buildAnimeSearchQuery,
} from './queries';
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
