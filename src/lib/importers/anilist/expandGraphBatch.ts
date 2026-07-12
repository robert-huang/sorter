/**
 * Batched paginated graph expansions — one AniList round-trip advances
 * many entity cursors at the same depth (same pattern as relations batch).
 */

import type { AnilistImportContext } from './context';
import {
  buildBatchedCharacterVoiceMediaQuery,
  buildBatchedStaffFilmographyCharacterMediaQuery,
  buildBatchedStaffFilmographyStaffMediaQuery,
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
import { TOOLS_CHARACTER_VOICE_MEDIA_QUERY } from './queries';
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
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
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

async function depaginateStaffCharacterMediaBatch(
  ctx: AnilistImportContext,
  staffIds: readonly number[],
  options: ExpandStaffFilmographyOptions,
  batchSize: number,
): Promise<
  Map<
    number,
    {
      edges: AnilistStaffCharacterMediaEdgeGql[];
      pagesFetched: number;
      staff: AnilistStaffGql | null;
      exists: boolean;
    }
  >
> {
  const perPage = options.perPage ?? DEFAULT_FILMOGRAPHY_PER_PAGE;
  const maxPages = options.charactersMaxPages;
  const states: PaginationState[] = staffIds.map((id) => ({ id, page: 1, done: false }));
  const edgesById = new Map<number, AnilistStaffCharacterMediaEdgeGql[]>();
  const pagesFetchedById = new Map<number, number>();
  const staffById = new Map<number, AnilistStaffGql | null>();
  const existsById = new Map<number, boolean>();

  for (const id of staffIds) {
    edgesById.set(id, []);
    pagesFetchedById.set(id, 0);
    staffById.set(id, null);
  }

  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
      const requests: BatchedPageRequest[] = group.map((state) => ({
        id: state.id,
        page: state.page,
      }));
      const built = buildBatchedStaffFilmographyCharacterMediaQuery(requests, perPage);
      const data = await ctx.executeQuery<Record<string, AnilistStaffFilmographyResponse['Staff']>>(
        built.query,
        built.variables,
      );

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const staff = data?.[`s${index}`] ?? null;
        if (!staff) {
          existsById.set(state.id, false);
          state.done = true;
          continue;
        }
        existsById.set(state.id, true);
        if (!staffById.get(state.id)) {
          staffById.set(state.id, staff);
        }
        const conn = staff.characterMedia;
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

  const out = new Map<
    number,
    {
      edges: AnilistStaffCharacterMediaEdgeGql[];
      pagesFetched: number;
      staff: AnilistStaffGql | null;
      exists: boolean;
    }
  >();
  for (const id of staffIds) {
    out.set(id, {
      edges: edgesById.get(id) ?? [],
      pagesFetched: pagesFetchedById.get(id) ?? 0,
      staff: staffById.get(id) ?? null,
      exists: existsById.get(id) ?? true,
    });
  }
  return out;
}

async function depaginateStaffStaffMediaBatch(
  ctx: AnilistImportContext,
  staffIds: readonly number[],
  options: ExpandStaffFilmographyOptions,
  batchSize: number,
): Promise<
  Map<
    number,
    {
      edges: AnilistStaffMediaEdgeGql[];
      pagesFetched: number;
      staff: AnilistStaffGql | null;
      exists: boolean;
    }
  >
> {
  const perPage = options.perPage ?? DEFAULT_FILMOGRAPHY_PER_PAGE;
  const maxPages = options.staffMediaMaxPages;
  const states: PaginationState[] = staffIds.map((id) => ({ id, page: 1, done: false }));
  const edgesById = new Map<number, AnilistStaffMediaEdgeGql[]>();
  const pagesFetchedById = new Map<number, number>();
  const staffById = new Map<number, AnilistStaffGql | null>();
  const existsById = new Map<number, boolean>();

  for (const id of staffIds) {
    edgesById.set(id, []);
    pagesFetchedById.set(id, 0);
    staffById.set(id, null);
  }

  while (states.some((state) => !state.done)) {
    const active = states.filter((state) => !state.done);
    for (const group of chunk(active, batchSize)) {
      const requests: BatchedPageRequest[] = group.map((state) => ({
        id: state.id,
        page: state.page,
      }));
      const built = buildBatchedStaffFilmographyStaffMediaQuery(requests, perPage);
      const data = await ctx.executeQuery<Record<string, AnilistStaffFilmographyResponse['Staff']>>(
        built.query,
        built.variables,
      );

      for (let index = 0; index < group.length; index += 1) {
        const state = group[index]!;
        const staff = data?.[`s${index}`] ?? null;
        if (!staff) {
          existsById.set(state.id, false);
          state.done = true;
          continue;
        }
        existsById.set(state.id, true);
        if (!staffById.get(state.id)) {
          staffById.set(state.id, staff);
        }
        const conn = staff.staffMedia;
        pagesFetchedById.set(state.id, (pagesFetchedById.get(state.id) ?? 0) + 1);
        if (conn) {
          edgesById.get(state.id)!.push(...conn.edges);
          emitProgress(ctx.onProgress, {
            kind: 'fetching-page',
            what: 'staff',
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

  const out = new Map<
    number,
    {
      edges: AnilistStaffMediaEdgeGql[];
      pagesFetched: number;
      staff: AnilistStaffGql | null;
      exists: boolean;
    }
  >();
  for (const id of staffIds) {
    out.set(id, {
      edges: edgesById.get(id) ?? [],
      pagesFetched: pagesFetchedById.get(id) ?? 0,
      staff: staffById.get(id) ?? null,
      exists: existsById.get(id) ?? true,
    });
  }
  return out;
}

export type ExpandCharacterMediaBatchOptions = ExpandCharacterMediaOptions & {
  batchSize?: number;
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
  const batchSize = options.batchSize ?? DEFAULT_CHARACTER_MEDIA_BATCH_SIZE;
  const perPage = options.perPage ?? DEFAULT_CHARACTER_MEDIA_PER_PAGE;
  const fetched = await depaginateCharacterVoiceMediaBatch(ctx, uniqueIds, options, batchSize);

  for (const characterId of uniqueIds) {
    const result = fetched.get(characterId);
    if (!result) {
      continue;
    }
    if (!result.exists) {
      continue;
    }
    if (result.edges.length === 0) {
      const probe = await ctx.executeQuery<AnilistCharacterVoiceMediaResponse>(
        TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
        { id: characterId, page: 1, perPage },
      );
      if (!probe?.Character) {
        continue;
      }
    }
    await persistCharacterMediaExpansion(ctx, characterId, result.edges, {
      voiceActorLanguage: options.voiceActorLanguage,
      pagesFetched: result.pagesFetched,
    });
  }
}

export type ExpandStaffFilmographyBatchOptions = ExpandStaffFilmographyOptions & {
  batchSize?: number;
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
  const batchSize = options.batchSize ?? DEFAULT_STAFF_FILMOGRAPHY_BATCH_SIZE;

  const charFetched = await depaginateStaffCharacterMediaBatch(
    ctx,
    uniqueIds,
    options,
    batchSize,
  );
  const staffMediaFetched = await depaginateStaffStaffMediaBatch(
    ctx,
    uniqueIds,
    options,
    batchSize,
  );

  for (const staffId of uniqueIds) {
    const charResult = charFetched.get(staffId);
    const staffMediaResult = staffMediaFetched.get(staffId);
    if (!charResult || !staffMediaResult) {
      continue;
    }
    if (!charResult.exists && !staffMediaResult.exists) {
      continue;
    }
    const characterEdges = charResult.edges;
    const staffMediaEdges = staffMediaResult.edges;
    let staffProfile = charResult.staff ?? staffMediaResult.staff;

    if (characterEdges.length === 0 && staffMediaEdges.length === 0) {
      const perPage = options.perPage ?? DEFAULT_FILMOGRAPHY_PER_PAGE;
      const built = buildBatchedStaffFilmographyCharacterMediaQuery(
        [{ id: staffId, page: 1 }],
        perPage,
      );
      const probe = await ctx.executeQuery<Record<string, AnilistStaffFilmographyResponse['Staff']>>(
        built.query,
        built.variables,
      );
      if (!probe?.s0) {
        continue;
      }
      staffProfile = staffProfile ?? probe.s0;
    }

    await persistStaffFilmographyExpansion(ctx, staffId, characterEdges, staffMediaEdges, {
      voiceActorLanguage: options.voiceActorLanguage,
      staffProfile,
      characterPagesFetched: charResult.pagesFetched,
      staffMediaPagesFetched: staffMediaResult.pagesFetched,
    });
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
  } catch {
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
  } catch {
    await expandStaffFilmography(ctx, staffId, options);
  }
}
