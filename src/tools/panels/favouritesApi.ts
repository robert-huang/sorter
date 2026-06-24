import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
  TOOLS_FAVOURITE_CHARACTERS_QUERY,
  TOOLS_FAVOURITE_STAFF_QUERY,
  TOOLS_USER_CONSUMED_MEDIA_QUERY,
  TOOLS_VA_CHARACTER_MEDIA_QUERY,
} from '../../lib/importers/anilist/queries';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  dbCharacterEdgesHaveVoiceCast,
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  ensureUserFavouritesFresh,
  isCharacterVoiceEdgesDbFresh,
  readCharacterVoiceEdgesFromDb,
  readConsumedMediaIdsFromDb,
  readFavouriteCharactersFromDb,
  readFavouriteStaffFromDb,
  readVaCharacterEdgesFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  buildFavouritesResult,
  countVaCharactersOnMedia,
  pickCharacterName,
  processCharacterEdges,
  type CharacterMediaEdge,
  type CharacterRoleTier,
  type FavouriteCharacterInput,
  type FavouriteStaffInput,
  type FavouritesForm,
  type FavouritesRebuildSource,
  type FavouritesResult,
  type FavouritesSeriesMeta,
  type VaMediaEdge,
} from './favouritesLogic';

export type FavouritesRunProgress =
  | { phase: 'list' }
  | { phase: 'characters' }
  | { phase: 'character-vas'; index: number; total: number; name: string }
  | { phase: 'va-totals'; index: number; total: number }
  | { phase: 'build' };

async function fetchConsumedMediaIds(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<Set<number>> {
  signal?.throwIfAborted();
  const user = await ensureUserAnimeListFresh(username, options);
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readConsumedMediaIdsFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }

  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{ mediaId: number }>;
      } | null;
    },
    { mediaId: number }
  >({
    query: TOOLS_USER_CONSUMED_MEDIA_QUERY,
    variables: { userName: username },
    signal,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });
  return new Set(entries.map((e) => e.mediaId));
}

async function fetchFavouriteCharactersLive(
  username: string,
  signal?: AbortSignal,
): Promise<FavouriteCharacterInput[]> {
  return depaginate<
    {
      User: {
        favourites: {
          characters: {
            pageInfo: { hasNextPage: boolean };
            nodes: FavouriteCharacterInput[];
          };
        };
      } | null;
    },
    FavouriteCharacterInput
  >({
    query: TOOLS_FAVOURITE_CHARACTERS_QUERY,
    variables: { username },
    signal,
    selectPage: (data) => ({
      nodes: data.User?.favourites.characters.nodes ?? [],
      pageInfo: data.User?.favourites.characters.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchFavouriteCharacters(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<FavouriteCharacterInput[]> {
  signal?.throwIfAborted();
  const user = await ensureUserFavouritesFresh(username, 'CHARACTERS', options);
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readFavouriteCharactersFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }
  return fetchFavouriteCharactersLive(username, signal);
}

async function fetchFavouriteStaffLive(
  username: string,
  signal?: AbortSignal,
): Promise<FavouriteStaffInput[]> {
  return depaginate<
    {
      User: {
        favourites: {
          staff: {
            pageInfo: { hasNextPage: boolean };
            nodes: FavouriteStaffInput[];
          };
        };
      } | null;
    },
    FavouriteStaffInput
  >({
    query: TOOLS_FAVOURITE_STAFF_QUERY,
    variables: { username },
    signal,
    selectPage: (data) => ({
      nodes: data.User?.favourites.staff.nodes ?? [],
      pageInfo: data.User?.favourites.staff.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchFavouriteStaff(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<FavouriteStaffInput[]> {
  signal?.throwIfAborted();
  const user = await ensureUserFavouritesFresh(username, 'STAFF', options);
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readFavouriteStaffFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }
  return fetchFavouriteStaffLive(username, signal);
}

async function fetchCharacterVoiceEdgesLive(
  charId: number,
  signal?: AbortSignal,
): Promise<CharacterMediaEdge[]> {
  return depaginate<
    {
      Character: {
        media: {
          pageInfo: { hasNextPage: boolean };
          edges: CharacterMediaEdge[];
        };
      } | null;
    },
    CharacterMediaEdge
  >({
    query: TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
    variables: { id: charId },
    signal,
    selectPage: (data) => ({
      nodes: data.Character?.media.edges ?? [],
      pageInfo: data.Character?.media.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchCharacterVoiceEdges(
  charId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<CharacterMediaEdge[]> {
  signal?.throwIfAborted();
  if (!options?.forceRefresh) {
    const ctx = getToolsImportContext();
    const fromDb = await readCharacterVoiceEdgesFromDb(ctx.db, charId);
    if (
      fromDb &&
      dbCharacterEdgesHaveVoiceCast(fromDb) &&
      (await isCharacterVoiceEdgesDbFresh(ctx.db, fromDb, options))
    ) {
      return fromDb;
    }
  }
  return fetchCharacterVoiceEdgesLive(charId, signal);
}

async function fetchVaCharacterEdgesLive(
  vaId: number,
  signal?: AbortSignal,
): Promise<VaMediaEdge[]> {
  return depaginate<
    {
      Staff: {
        characterMedia: {
          pageInfo: { hasNextPage: boolean };
          edges: VaMediaEdge[];
        };
      } | null;
    },
    VaMediaEdge
  >({
    query: TOOLS_VA_CHARACTER_MEDIA_QUERY,
    variables: { id: vaId },
    signal,
    selectPage: (data) => ({
      nodes: data.Staff?.characterMedia.edges ?? [],
      pageInfo: data.Staff?.characterMedia.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchVaCharacterEdges(
  vaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<VaMediaEdge[]> {
  signal?.throwIfAborted();
  await ensureStaffFilmographyFresh(vaId, options);
  if (!options?.forceRefresh) {
    const ctx = getToolsImportContext();
    const fromDb = await readVaCharacterEdgesFromDb(ctx.db, vaId);
    if (fromDb) {
      return fromDb;
    }
  }
  return fetchVaCharacterEdgesLive(vaId, signal);
}

export type FavouritesAnalysisPayload = {
  result: FavouritesResult;
  rebuildSource: FavouritesRebuildSource;
};

export async function runFavouritesAnalysis(
  form: FavouritesForm,
  onProgress: (progress: FavouritesRunProgress) => void,
  signal?: AbortSignal,
  fetchOptions?: ToolsFetchOptions,
): Promise<FavouritesAnalysisPayload> {
  const username = form.username.trim();
  onProgress({ phase: 'list' });
  const consumedMediaIds = await fetchConsumedMediaIds(username, signal, fetchOptions);

  onProgress({ phase: 'characters' });
  const [characters, favouriteStaff] = await Promise.all([
    fetchFavouriteCharacters(username, signal, fetchOptions),
    fetchFavouriteStaff(username, signal, fetchOptions),
  ]);

  if (characters.length === 0) {
    throw new Error('This user has no favourite characters.');
  }

  const perCharacterVas: Array<Array<{ id: number; name: string; imageUrl: string | null }>> = [];
  const perCharacterMeta: Array<{
    charRole: CharacterRoleTier;
    seen: boolean;
    isMain: boolean;
    shows: Record<number, FavouritesSeriesMeta>;
    books: Record<number, FavouritesSeriesMeta>;
  }> = [];
  const perCharacterEdges: CharacterMediaEdge[][] = [];
  const vaIds = new Set<number>();

  for (let i = 0; i < characters.length; i += 1) {
    signal?.throwIfAborted();
    const character = characters[i]!;
    const charName = pickCharacterName(character);

    onProgress({
      phase: 'character-vas',
      index: i + 1,
      total: characters.length,
      name: charName,
    });

    const edges = await fetchCharacterVoiceEdges(character.id, signal, fetchOptions);
    perCharacterEdges.push(edges);
    const processed = processCharacterEdges(
      character.id,
      charName,
      edges,
      consumedMediaIds,
    );

    perCharacterVas.push(processed.vas);
    perCharacterMeta.push({
      charRole: processed.charRole,
      seen: processed.seen,
      isMain: processed.isMain,
      shows: processed.shows,
      books: processed.books,
    });

    for (const va of processed.vas) {
      vaIds.add(va.id);
    }
  }

  const vaTotalCharacterCounts = new Map<number, number>();
  const vaIdList = [...vaIds];
  for (let i = 0; i < vaIdList.length; i += 1) {
    signal?.throwIfAborted();
    const vaId = vaIdList[i]!;
    onProgress({ phase: 'va-totals', index: i + 1, total: vaIdList.length });
    const edges = await fetchVaCharacterEdges(vaId, signal, fetchOptions);
    vaTotalCharacterCounts.set(vaId, countVaCharactersOnMedia(edges, consumedMediaIds));
  }

  onProgress({ phase: 'build' });
  const rebuildSource: FavouritesRebuildSource = {
    characters,
    perCharacterEdges,
    consumedMediaIds,
    favouriteStaff,
    vaTotalCharacterCounts,
  };
  return {
    result: buildFavouritesResult({
      characters,
      perCharacterVas,
      perCharacterMeta,
      vaTotalCharacterCounts,
      favouriteStaff,
    }),
    rebuildSource,
  };
}
