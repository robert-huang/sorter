import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
  TOOLS_FAVOURITE_CHARACTERS_QUERY,
  TOOLS_FAVOURITE_STAFF_QUERY,
  TOOLS_USER_CONSUMED_MEDIA_QUERY,
  TOOLS_VA_CHARACTER_MEDIA_QUERY,
} from '../../lib/importers/anilist/queries';
import {
  favouritesGraphForceOptions,
  favouritesImportOptions,
  type FavouritesFetchOptions,
} from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  FAVOURITES_SESSION_TTL_MS,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import {
  ensureCharacterMediaFresh,
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  ensureUserFavouritesFresh,
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

/** Normal Analyze caps character-media live fallback at two pages. */
const FAVOURITES_CHARACTER_MEDIA_MAX_PAGES = 2;

export type FavouritesRunProgress =
  | { phase: 'list' }
  | { phase: 'characters' }
  | { phase: 'character-vas'; index: number; total: number; name: string }
  | { phase: 'va-totals'; index: number; total: number }
  | { phase: 'expand-staff-filmography'; index: number; total: number }
  | { phase: 'build' };

async function fetchConsumedMediaIds(
  username: string,
  signal?: AbortSignal,
): Promise<Set<number>> {
  signal?.throwIfAborted();
  const user = await ensureUserAnimeListFresh(username);
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

async function fetchFavouriteCharactersFromDbOrLive(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<FavouriteCharacterInput[]> {
  const user = await ensureUserFavouritesFresh(
    username,
    'CHARACTERS',
    favouritesImportOptions(options),
  );
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readFavouriteCharactersFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }
  return fetchFavouriteCharactersLive(username, signal);
}

async function fetchFavouriteCharacters(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<FavouriteCharacterInput[]> {
  signal?.throwIfAborted();
  const handle = username.trim().toLowerCase();
  return withSessionTtlMemo(
    `fav:chars:${handle}`,
    FAVOURITES_SESSION_TTL_MS,
    () => fetchFavouriteCharactersFromDbOrLive(username, signal, options),
    { bust: options?.forceRefreshFavourites },
  );
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

async function fetchFavouriteStaffFromDbOrLive(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<FavouriteStaffInput[]> {
  const user = await ensureUserFavouritesFresh(
    username,
    'STAFF',
    favouritesImportOptions(options),
  );
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readFavouriteStaffFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }
  return fetchFavouriteStaffLive(username, signal);
}

async function fetchFavouriteStaff(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<FavouriteStaffInput[]> {
  signal?.throwIfAborted();
  const handle = username.trim().toLowerCase();
  return withSessionTtlMemo(
    `fav:staff:${handle}`,
    FAVOURITES_SESSION_TTL_MS,
    () => fetchFavouriteStaffFromDbOrLive(username, signal, options),
    { bust: options?.forceRefreshFavourites },
  );
}

async function fetchCharacterVoiceEdgesLive(
  charId: number,
  signal?: AbortSignal,
  maxPages?: number,
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
    maxPages,
    selectPage: (data) => ({
      nodes: data.Character?.media.edges ?? [],
      pageInfo: data.Character?.media.pageInfo ?? { hasNextPage: false },
    }),
  });
}

async function fetchCharacterVoiceEdges(
  charId: number,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<CharacterMediaEdge[]> {
  signal?.throwIfAborted();
  const ctx = getToolsImportContext();

  if (options?.expandRoles) {
    await ensureCharacterMediaFresh(charId, favouritesGraphForceOptions(options));
    const fromDb = await readCharacterVoiceEdgesFromDb(ctx.db, charId);
    if (fromDb) {
      return fromDb;
    }
    return fetchCharacterVoiceEdgesLive(charId, signal);
  }

  const fromDb = await readCharacterVoiceEdgesFromDb(ctx.db, charId);
  if (fromDb) {
    return fromDb;
  }
  return fetchCharacterVoiceEdgesLive(
    charId,
    signal,
    FAVOURITES_CHARACTER_MEDIA_MAX_PAGES,
  );
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
  options?: FavouritesFetchOptions,
): Promise<VaMediaEdge[]> {
  signal?.throwIfAborted();
  const ctx = getToolsImportContext();

  if (options?.expandRoles) {
    await ensureStaffFilmographyFresh(vaId, favouritesGraphForceOptions(options));
    const fromDb = await readVaCharacterEdgesFromDb(ctx.db, vaId);
    if (fromDb) {
      return fromDb;
    }
    return fetchVaCharacterEdgesLive(vaId, signal);
  }

  const fromDb = await readVaCharacterEdgesFromDb(ctx.db, vaId);
  if (fromDb) {
    return fromDb;
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
  fetchOptions?: FavouritesFetchOptions,
): Promise<FavouritesAnalysisPayload> {
  const username = form.username.trim();
  onProgress({ phase: 'list' });
  const consumedMediaIds = await fetchConsumedMediaIds(username, signal);

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

  if (fetchOptions?.expandRoles) {
    const staffToExpand = favouriteStaff
      .map((staff) => staff.id)
      .filter((staffId) => !vaIds.has(staffId));
    for (let i = 0; i < staffToExpand.length; i += 1) {
      signal?.throwIfAborted();
      const staffId = staffToExpand[i]!;
      onProgress({
        phase: 'expand-staff-filmography',
        index: i + 1,
        total: staffToExpand.length,
      });
      await ensureStaffFilmographyFresh(staffId, favouritesGraphForceOptions(fetchOptions));
    }
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
