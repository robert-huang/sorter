/**
 * Batched paginated graph expansions — one AniList round-trip advances
 * many entity cursors at the same depth (same pattern as relations batch).
 */

import type { AnilistImportContext } from './context';
import {
  buildBatchedCharacterVoiceMediaQuery,
  buildBatchedStaffFilmographyQuery,
  type BatchedPageRequest,
} from './batchGraphQueries';
import {
  DEFAULT_CHARACTER_MEDIA_PER_PAGE,
  expandCharacterMedia,
  persistCharacterMediaExpansion,
  type ExpandCharacterMediaOptions,
} from './expandCharacterMedia';
import {
  DEFAULT_FILMOGRAPHY_PER_PAGE,
  expandStaffFilmography,
  persistStaffFilmographyExpansion,
  type ExpandStaffFilmographyOptions,
} from './expandStaffFilmography';
import { emitProgress } from './progress';
import type {
  AnilistCharacterMediaEdgeGql,
  AnilistCharacterVoiceMediaResponse,
  AnilistStaffCharacterMediaEdgeGql,
  AnilistStaffFilmographyResponse,
  AnilistStaffGql,
  AnilistStaffMediaEdgeGql,
} from './types';

export const DEFAULT_CHARACTER_MEDIA_BATCH_SIZE = 8;
export const DEFAULT_STAFF_FILMOGRAPHY_BATCH_SIZE = 5;

type PaginationState = {
  id: number;
  page: number;
  done: boolean;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    out.push(items.slice(offset, offset + size) as T[]);
  }
  return out;
}

async function depaginateCharacterVoiceMediaBatch(
  ctx: AnilistImportContext,
  characterIds: readonly number[],
  options: ExpandCharacterMediaOptions,
  batchSize: number,
): Promise<Map<number, { edges: AnilistCharacterMediaEdgeGql[]; pagesFetched: number; exists: boolean }>> {
  const perPage = options.perPage ?? DEFAULT_CHARACTER_MEDIA_PER_PAGE;
  const maxPages = options.maxPages;
  const states: PaginationState[] = characterIds.map((id) => ({
    id,
    page: 1,
    done: false,
  }));
  const edgesById = new Map<number, AnilistCharacterMediaEdgeGql[]>();
  const pagesFetchedById = new Map<number, number>();
  const existsById = new Map<number, boolean>();

  for (const id of characterIds) {
    edgesById.set(id, []);
    pagesFetchedById.set(id, 0);
  }

  while (states.some((state) => !state.done)) {
    options.signal?.throwIfAborted();
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
      options.signal?.throwIfAborted();
      const requests: BatchedPageRequest[] = group.map((state) => ({
        id: state.id,
        page: state.page,
      }));
      const { query, variables } = buildBatchedCharacterVoiceMediaQuery(requests, perPage);
      const data = await ctx.executeQuery<
        Record<string, AnilistCharacterVoiceMediaResponse['Character'] | null | undefined>
      >(query, variables);

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const character = data?.[`c${index}`];
        if (!character) {
          existsById.set(state.id, false);
          state.done = true;
          continue;
        }
        existsById.set(state.id, true);
        const conn = character.media;
        pagesFetchedById.set(state.id, (pagesFetchedById.get(state.id) ?? 0) + 1);
        if (conn) {
          edgesById.get(state.id)!.push(...conn.edges);
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'characters',
            page: state.page,
            itemsSoFar: edgesById.get(state.id)!.length,
          });
          const hitMaxPages = maxPages != null && (pagesFetchedById.get(state.id) ?? 0) >= maxPages;
          if (!conn.pageInfo.hasNextPage || hitMaxPages) {
            state.done = true;
          } else {
            state.page += 1;
          }
        } else {
          state.done = true;
        }
      }
    }
  }

  const out = new Map<number, { edges: AnilistCharacterMediaEdgeGql[]; pagesFetched: number; exists: boolean }>();
  for (const id of characterIds) {
    out.set(id, {
      edges: edgesById.get(id) ?? [],
      pagesFetched: pagesFetchedById.get(id) ?? 0,
      exists: existsById.get(id) ?? true,
    });
  }
  return out;
}

type StaffFilmographyBatchResult = {
  characterEdges: AnilistStaffCharacterMediaEdgeGql[];
  staffMediaEdges: AnilistStaffMediaEdgeGql[];
  characterPagesFetched: number;
  staffMediaPagesFetched: number;
  staff: AnilistStaffGql | null;
  exists: boolean;
};

type StaffFilmographyPaginationState = StaffFilmographyBatchResult & {
  id: number;
  charactersPage: number;
  staffMediaPage: number;
  charactersDone: boolean;
  staffMediaDone: boolean;
};

async function depaginateStaffFilmographyBatch(
  ctx: AnilistImportContext,
  staffIds: readonly number[],
  options: ExpandStaffFilmographyOptions,
  batchSize: number,
): Promise<Map<number, StaffFilmographyBatchResult>> {
  const perPage = options.perPage ?? DEFAULT_FILMOGRAPHY_PER_PAGE;
  const states: StaffFilmographyPaginationState[] = staffIds.map((id) => ({
    id,
    charactersPage: 1,
    staffMediaPage: 1,
    charactersDone: options.charactersMaxPages === 0,
    staffMediaDone: options.staffMediaMaxPages === 0,
    characterEdges: [],
    staffMediaEdges: [],
    characterPagesFetched: 0,
    staffMediaPagesFetched: 0,
    staff: null,
    exists: false,
  }));

  while (states.some((state) => !state.charactersDone || !state.staffMediaDone)) {
    options.signal?.throwIfAborted();
    const active = states.filter(
      (state) => !state.charactersDone || !state.staffMediaDone,
    );
    for (const group of chunk(active, batchSize)) {
      options.signal?.throwIfAborted();
      const requests = group.map((state) => ({
        id: state.id,
        charactersPage: state.charactersPage,
        staffMediaPage: state.staffMediaPage,
        includeCharacters: !state.charactersDone,
        includeStaffMedia: !state.staffMediaDone,
      }));
      const built = buildBatchedStaffFilmographyQuery(requests, perPage);
      const data = await ctx.executeQuery<Record<string, AnilistStaffFilmographyResponse['Staff']>>(
        built.query,
        built.variables,
      );

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const staff = data?.[`s${index}`] ?? null;
        if (!staff) {
          state.charactersDone = true;
          state.staffMediaDone = true;
          continue;
        }
        state.exists = true;
        if (!state.staff) {
          state.staff = staff;
        }

        if (!state.charactersDone) {
          const conn = staff.characterMedia;
          state.characterPagesFetched += 1;
          if (conn) {
            state.characterEdges.push(...conn.edges);
          }
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'characters',
            page: state.charactersPage,
            itemsSoFar: state.characterEdges.length,
          });
          const hitMaxPages =
            options.charactersMaxPages !== undefined &&
            state.characterPagesFetched >= options.charactersMaxPages;
          state.charactersDone = !conn?.pageInfo.hasNextPage || hitMaxPages;
          if (!state.charactersDone) {
            state.charactersPage += 1;
          }
        }

        if (!state.staffMediaDone) {
          const conn = staff.staffMedia;
          state.staffMediaPagesFetched += 1;
          if (conn) {
            state.staffMediaEdges.push(...conn.edges);
          }
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'staff',
            page: state.staffMediaPage,
            itemsSoFar: state.staffMediaEdges.length,
          });
          const hitMaxPages =
            options.staffMediaMaxPages !== undefined &&
            state.staffMediaPagesFetched >= options.staffMediaMaxPages;
          state.staffMediaDone = !conn?.pageInfo.hasNextPage || hitMaxPages;
          if (!state.staffMediaDone) {
            state.staffMediaPage += 1;
          }
        }
      }
    }
  }

  return new Map(
    states.map((state) => [state.id, {
      characterEdges: state.characterEdges,
      staffMediaEdges: state.staffMediaEdges,
      characterPagesFetched: state.characterPagesFetched,
      staffMediaPagesFetched: state.staffMediaPagesFetched,
      staff: state.staff,
      exists: state.exists,
    }]),
  );
}

export type ExpandCharacterMediaBatchOptions = ExpandCharacterMediaOptions & {
  batchSize?: number;
  onCheckpoint?: (characterId: number) => void;
};

export async function expandCharacterMediaBatch(
  ctx: AnilistImportContext,
  characterIds: readonly number[],
  options: ExpandCharacterMediaBatchOptions = {},
): Promise<void> {
  const uniqueIds = [...new Set(characterIds)];
  if (uniqueIds.length === 0) {
    return;
  }
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_CHARACTER_MEDIA_BATCH_SIZE);

  if (uniqueIds.length > batchSize) {
    for (const group of chunk(uniqueIds, batchSize)) {
      options.signal?.throwIfAborted();
      await expandCharacterMediaBatch(ctx, group, { ...options, batchSize });
    }
    return;
  }

  const fetched = await depaginateCharacterVoiceMediaBatch(ctx, uniqueIds, options, batchSize);

  for (const characterId of uniqueIds) {
    options.signal?.throwIfAborted();
    const result = fetched.get(characterId);
    if (!result) {
      continue;
    }
    if (!result.exists) {
      continue;
    }
    await persistCharacterMediaExpansion(ctx, characterId, result.edges, {
      voiceActorLanguage: options.voiceActorLanguage,
      pagesFetched: result.pagesFetched,
    });
    options.onCheckpoint?.(characterId);
  }
}

export type ExpandStaffFilmographyBatchOptions = ExpandStaffFilmographyOptions & {
  batchSize?: number;
  onCheckpoint?: (staffId: number) => void;
};

export async function expandStaffFilmographyBatch(
  ctx: AnilistImportContext,
  staffIds: readonly number[],
  options: ExpandStaffFilmographyBatchOptions = {},
): Promise<void> {
  const uniqueIds = [...new Set(staffIds)];
  if (uniqueIds.length === 0) {
    return;
  }
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_STAFF_FILMOGRAPHY_BATCH_SIZE);

  if (uniqueIds.length > batchSize) {
    for (const group of chunk(uniqueIds, batchSize)) {
      options.signal?.throwIfAborted();
      await expandStaffFilmographyBatch(ctx, group, { ...options, batchSize });
    }
    return;
  }

  const fetched = await depaginateStaffFilmographyBatch(
    ctx,
    uniqueIds,
    options,
    batchSize,
  );

  for (const staffId of uniqueIds) {
    options.signal?.throwIfAborted();
    const result = fetched.get(staffId);
    if (!result?.exists) {
      continue;
    }

    await persistStaffFilmographyExpansion(
      ctx,
      staffId,
      result.characterEdges,
      result.staffMediaEdges,
      {
        voiceActorLanguage: options.voiceActorLanguage,
        staffProfile: result.staff,
        characterPagesFetched: result.characterPagesFetched,
        staffMediaPagesFetched: result.staffMediaPagesFetched,
      },
    );
    options.onCheckpoint?.(staffId);
  }
}

function throwIfGraphExpansionAborted(
  error: unknown,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) {
    signal.throwIfAborted();
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw error;
  }
}

/** Fallback to single-entity expand when batch GraphQL fails mid-run. */
export async function expandCharacterMediaWithFallback(
  ctx: AnilistImportContext,
  characterId: number,
  options: ExpandCharacterMediaOptions = {},
): Promise<void> {
  try {
    await expandCharacterMediaBatch(ctx, [characterId], options);
  } catch (error) {
    throwIfGraphExpansionAborted(error, options.signal);
    await expandCharacterMedia(ctx, characterId, options);
  }
}

export async function expandStaffFilmographyWithFallback(
  ctx: AnilistImportContext,
  staffId: number,
  options: ExpandStaffFilmographyOptions = {},
): Promise<void> {
  try {
    await expandStaffFilmographyBatch(ctx, [staffId], options);
  } catch (error) {
    throwIfGraphExpansionAborted(error, options.signal);
    await expandStaffFilmography(ctx, staffId, options);
  }
}
