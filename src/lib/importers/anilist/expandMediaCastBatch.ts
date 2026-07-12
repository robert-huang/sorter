/**
 * Batched paginated media cast expansion — one AniList round-trip advances
 * many media character/staff cursors at the same depth.
 */

import type { AnilistImportContext } from './context';
import {
  buildBatchedMediaCharactersQuery,
  buildBatchedMediaStaffQuery,
  type BatchedPageRequest,
} from './batchGraphQueries';
import {
  DEFAULT_DETAIL_PER_PAGE,
  DEFAULT_VOICE_ACTOR_LANGUAGE,
  ensureMediaRowsForCastExpansion,
  expandAnilistMediaDetail,
  persistMediaCastExpansion,
  readMediaCastExpansionPatch,
  type ExpandAnilistMediaDetailOptions,
  type ExpandAnilistMediaDetailScope,
} from './lazyExpansion';
import { emitProgress } from './progress';
import type {
  AnilistMediaCharacterEdgeGql,
  AnilistMediaDetailResponse,
  AnilistMediaStaffEdgeGql,
  AnilistMediaStaffOnlyResponse,
  AnilistStaffLanguage,
} from './types';

export const DEFAULT_MEDIA_CAST_BATCH_SIZE = 5;

type PaginationState = {
  id: number;
  page: number;
  done: boolean;
};

type MediaCastPending = {
  mediaId: number;
  scope: ExpandAnilistMediaDetailScope;
};

type DepaginatedCharacters = {
  edges: AnilistMediaCharacterEdgeGql[];
  pagesFetched: number;
  complete: boolean;
  exists: boolean;
};

type DepaginatedStaff = {
  edges: AnilistMediaStaffEdgeGql[];
  pagesFetched: number;
  complete: boolean;
  exists: boolean;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    out.push(items.slice(offset, offset + size) as T[]);
  }
  return out;
}

async function depaginateMediaCharactersBatch(
  ctx: AnilistImportContext,
  mediaIds: readonly number[],
  options: ExpandAnilistMediaDetailOptions,
  batchSize: number,
  language: AnilistStaffLanguage,
): Promise<Map<number, DepaginatedCharacters>> {
  const perPage = options.perPage ?? DEFAULT_DETAIL_PER_PAGE;
  const maxPages = options.charactersMaxPages;
  const states: PaginationState[] = mediaIds.map((id) => ({
    id,
    page: 1,
    done: false,
  }));
  const edgesById = new Map<number, AnilistMediaCharacterEdgeGql[]>();
  const pagesFetchedById = new Map<number, number>();
  const existsById = new Map<number, boolean>();
  const completeById = new Map<number, boolean>();

  for (const id of mediaIds) {
    edgesById.set(id, []);
    pagesFetchedById.set(id, 0);
  }

  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
      const requests: BatchedPageRequest[] = group.map((state) => ({
        id: state.id,
        page: state.page,
      }));
      const built = buildBatchedMediaCharactersQuery(requests, perPage, language);
      const data = await ctx.executeQuery<
        Record<string, AnilistMediaDetailResponse['Media'] | null | undefined>
      >(built.query, built.variables);

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const media = data?.[`m${index}`];
        if (!media) {
          existsById.set(state.id, false);
          state.done = true;
          continue;
        }
        existsById.set(state.id, true);
        const conn = media.characters;
        pagesFetchedById.set(state.id, (pagesFetchedById.get(state.id) ?? 0) + 1);
        if (conn) {
          edgesById.get(state.id)!.push(...conn.edges);
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'characters',
            page: state.page,
            itemsSoFar: edgesById.get(state.id)!.length,
          });
          const hitMaxPages =
            maxPages != null && (pagesFetchedById.get(state.id) ?? 0) >= maxPages;
          if (!conn.pageInfo.hasNextPage || hitMaxPages) {
            completeById.set(state.id, !conn.pageInfo.hasNextPage);
            state.done = true;
          } else {
            state.page += 1;
          }
        } else {
          completeById.set(state.id, true);
          state.done = true;
        }
      }
    }
  }

  const out = new Map<number, DepaginatedCharacters>();
  for (const id of mediaIds) {
    const pagesFetched = pagesFetchedById.get(id) ?? 0;
    const exists = existsById.get(id) ?? false;
    out.set(id, {
      edges: edgesById.get(id) ?? [],
      pagesFetched,
      complete: exists ? (completeById.get(id) ?? pagesFetched === 0) : false,
      exists,
    });
  }
  return out;
}

async function depaginateMediaStaffBatch(
  ctx: AnilistImportContext,
  mediaIds: readonly number[],
  options: ExpandAnilistMediaDetailOptions,
  batchSize: number,
): Promise<Map<number, DepaginatedStaff>> {
  const perPage = options.perPage ?? DEFAULT_DETAIL_PER_PAGE;
  const maxPages = options.staffMaxPages;
  const states: PaginationState[] = mediaIds.map((id) => ({
    id,
    page: 1,
    done: false,
  }));
  const edgesById = new Map<number, AnilistMediaStaffEdgeGql[]>();
  const pagesFetchedById = new Map<number, number>();
  const existsById = new Map<number, boolean>();
  const completeById = new Map<number, boolean>();

  for (const id of mediaIds) {
    edgesById.set(id, []);
    pagesFetchedById.set(id, 0);
  }

  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
      const requests: BatchedPageRequest[] = group.map((state) => ({
        id: state.id,
        page: state.page,
      }));
      const built = buildBatchedMediaStaffQuery(requests, perPage);
      const data = await ctx.executeQuery<
        Record<string, AnilistMediaStaffOnlyResponse['Media'] | null | undefined>
      >(built.query, built.variables);

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const media = data?.[`m${index}`];
        if (!media) {
          existsById.set(state.id, false);
          state.done = true;
          continue;
        }
        existsById.set(state.id, true);
        const conn = media.staff;
        pagesFetchedById.set(state.id, (pagesFetchedById.get(state.id) ?? 0) + 1);
        if (conn) {
          edgesById.get(state.id)!.push(...conn.edges);
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'staff',
            page: state.page,
            itemsSoFar: edgesById.get(state.id)!.length,
          });
          const hitMaxPages =
            maxPages != null && (pagesFetchedById.get(state.id) ?? 0) >= maxPages;
          if (!conn.pageInfo.hasNextPage || hitMaxPages) {
            completeById.set(state.id, !conn.pageInfo.hasNextPage);
            state.done = true;
          } else {
            state.page += 1;
          }
        } else {
          completeById.set(state.id, true);
          state.done = true;
        }
      }
    }
  }

  const out = new Map<number, DepaginatedStaff>();
  for (const id of mediaIds) {
    const pagesFetched = pagesFetchedById.get(id) ?? 0;
    const exists = existsById.get(id) ?? false;
    out.set(id, {
      edges: edgesById.get(id) ?? [],
      pagesFetched,
      complete: exists ? (completeById.get(id) ?? pagesFetched === 0) : false,
      exists,
    });
  }
  return out;
}

export type ExpandMediaCastBatchOptions = ExpandAnilistMediaDetailOptions & {
  batchSize?: number;
};

export async function expandMediaCastBatch(
  ctx: AnilistImportContext,
  pending: readonly MediaCastPending[],
  options: ExpandMediaCastBatchOptions = {},
): Promise<void> {
  if (pending.length === 0) {
    return;
  }

  const batchSize = options.batchSize ?? DEFAULT_MEDIA_CAST_BATCH_SIZE;
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;
  const now = ctx.now();
  // Collapse duplicate media ids so one round-trip never advances the same
  // cursor twice (siblings expandCharacterMediaBatch/… dedupe the same way).
  const dedupedByMedia = new Map<number, MediaCastPending>();
  for (const item of pending) {
    if (!dedupedByMedia.has(item.mediaId)) {
      dedupedByMedia.set(item.mediaId, item);
    }
  }
  const uniquePending = [...dedupedByMedia.values()];
  const mediaIds = uniquePending.map((item) => item.mediaId);

  const okMedia = await ensureMediaRowsForCastExpansion(ctx, mediaIds, {
    refreshMetadata: options.force,
  });

  const charIds = uniquePending
    .filter((item) => item.scope === 'all' || item.scope === 'characters')
    .map((item) => item.mediaId)
    .filter((id) => okMedia.has(id));
  const staffIds = uniquePending
    .filter((item) => item.scope === 'all' || item.scope === 'staff')
    .map((item) => item.mediaId)
    .filter((id) => okMedia.has(id));

  const charFetched =
    charIds.length > 0
      ? await depaginateMediaCharactersBatch(ctx, charIds, options, batchSize, language)
      : new Map<number, DepaginatedCharacters>();
  const staffFetched =
    staffIds.length > 0
      ? await depaginateMediaStaffBatch(ctx, staffIds, options, batchSize)
      : new Map<number, DepaginatedStaff>();

  for (const item of uniquePending) {
    if (!okMedia.has(item.mediaId)) {
      continue;
    }

    const existing = await readMediaCastExpansionPatch(ctx, item.mediaId);
    const charResult = charFetched.get(item.mediaId);
    const staffResult = staffFetched.get(item.mediaId);

    if ((item.scope === 'all' || item.scope === 'characters') && (!charResult || !charResult.exists)) {
      continue;
    }
    if (item.scope === 'staff' && (!staffResult || !staffResult.exists)) {
      continue;
    }

    let characterEdges: AnilistMediaCharacterEdgeGql[] = [];
    let staffEdges: AnilistMediaStaffEdgeGql[] = [];
    let characterPagesFetched = 0;
    let staffPagesFetched = 0;
    let charactersComplete = existing?.charactersComplete ?? false;
    let staffComplete = existing?.staffComplete ?? false;
    let charactersFetchedAt = existing?.charactersFetchedAt ?? null;
    let staffFetchedAt = existing?.staffFetchedAt ?? null;

    if (item.scope === 'all' || item.scope === 'characters') {
      if (!charResult) {
        continue;
      }
      characterEdges = charResult.edges;
      characterPagesFetched = charResult.pagesFetched;
      charactersComplete = charResult.complete;
      charactersFetchedAt = now;
    }

    if (item.scope === 'all' || item.scope === 'staff') {
      if (!staffResult) {
        if (item.scope === 'staff') {
          continue;
        }
      } else {
        staffEdges = staffResult.edges;
        staffPagesFetched = staffResult.pagesFetched;
        staffComplete = staffResult.complete;
        staffFetchedAt = now;
      }
    }

    await persistMediaCastExpansion(ctx, {
      mediaId: item.mediaId,
      scope: item.scope,
      characterEdges,
      staffEdges,
      language,
      charactersComplete,
      staffComplete,
      charactersFetchedAt,
      staffFetchedAt,
      existing,
      characterPagesFetched,
      staffPagesFetched,
    });
  }
}

/** Fallback to single-entity expand when batch GraphQL fails mid-run. */
export async function expandMediaCastWithFallback(
  ctx: AnilistImportContext,
  pending: readonly MediaCastPending[],
  options: ExpandMediaCastBatchOptions = {},
): Promise<void> {
  try {
    await expandMediaCastBatch(ctx, pending, options);
  } catch {
    for (const item of pending) {
      await expandAnilistMediaDetail(ctx, item.mediaId, {
        ...options,
        scope: item.scope,
      });
    }
  }
}
