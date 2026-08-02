import {
  hasCharacterMediaExpansion,
  hasStaffFilmography,
} from '../../lib/importers/anilist/graphQueries';
import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
  TOOLS_VA_CHARACTER_MEDIA_QUERY,
} from '../../lib/importers/anilist/queries';
import {
  favouritesGraphForceOptions,
  favouritesImportOptions,
  type FavouritesFetchOptions,
} from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  FAVOURITES_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import {
  ensureCharacterMediaFreshBatch,
  ensureStaffFilmographyFreshBatch,
  ensureUserAnimeListFresh,
  ensureUserMangaListFresh,
  ensureUserFavouritesFresh,
  readCharacterVoiceEdgesFromDb,
  readConsumedMediaIdsFromDb,
  readFavouriteCharactersFromDb,
  readFavouriteStaffFromDb,
  readVaCharacterEdgesFromDb,
  countVaMainRoleCharactersOnConsumedMediaFromDb,
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

/**
 * Drop the favourites list session memo for a given username. Called by
 * the ↻ refresh button after a force re-import — without this the next
 * Analyze keeps serving the pre-refresh list for up to 15 minutes.
 */
export function bustFavouritesSessionMemo(username: string): void {
  const handle = username.trim().toLowerCase();
  if (!handle) {
    return;
  }
  sessionMemoDelete(`fav:chars:${handle}`);
  sessionMemoDelete(`fav:staff:${handle}`);
}

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
  // List imports share the per-source AniList scrape lock — run sequentially
  // (same as the ↻ refresh button) so parallel ensure* calls don't race.
  const animeUser = await ensureUserAnimeListFresh(username);
  signal?.throwIfAborted();
  const mangaUser = await ensureUserMangaListFresh(username);
  const user = animeUser ?? mangaUser;
  if (user) {
    const ctx = getToolsImportContext();
    return readConsumedMediaIdsFromDb(ctx.db, user.id);
  }
  return new Set();
}

async function fetchFavouriteCharactersFromDb(
  username: string,
  options?: FavouritesFetchOptions,
): Promise<FavouriteCharacterInput[]> {
  const user = await ensureUserFavouritesFresh(
    username,
    'CHARACTERS',
    favouritesImportOptions(options),
  );
  if (user) {
    const ctx = getToolsImportContext();
    return readFavouriteCharactersFromDb(ctx.db, user.id);
  }
  return [];
}

async function fetchFavouriteCharacters(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<FavouriteCharacterInput[]> {
  signal?.throwIfAborted();
  const handle = username.trim().toLowerCase();
  // expandRoles is a deep-fetch path; bust the memo so we re-read the
  // (post-import) DB list instead of serving a pre-expandRoles cache.
  return withSessionTtlMemo(
    `fav:chars:${handle}`,
    FAVOURITES_SESSION_TTL_MS,
    () => fetchFavouriteCharactersFromDb(username, options),
    { bust: !!(options?.forceRefreshFavourites || options?.expandRoles) },
  );
}

async function fetchFavouriteStaffFromDb(
  username: string,
  options?: FavouritesFetchOptions,
): Promise<FavouriteStaffInput[]> {
  const user = await ensureUserFavouritesFresh(
    username,
    'STAFF',
    favouritesImportOptions(options),
  );
  if (user) {
    const ctx = getToolsImportContext();
    return readFavouriteStaffFromDb(ctx.db, user.id);
  }
  return [];
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
    () => fetchFavouriteStaffFromDb(username, options),
    { bust: !!(options?.forceRefreshFavourites || options?.expandRoles) },
  );
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

async function readCharacterVoiceEdgesCached(
  charId: number,
  signal?: AbortSignal,
): Promise<CharacterMediaEdge[]> {
  signal?.throwIfAborted();
  const ctx = getToolsImportContext();
  const fromDb = await readCharacterVoiceEdgesFromDb(ctx.db, charId);
  if (fromDb) {
    return fromDb;
  }
  if (await hasCharacterMediaExpansion(ctx.db, charId)) {
    return [];
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

async function readVaCharacterEdgesCached(
  vaId: number,
  signal?: AbortSignal,
): Promise<VaMediaEdge[]> {
  signal?.throwIfAborted();
  const ctx = getToolsImportContext();
  const fromDb = await readVaCharacterEdgesFromDb(ctx.db, vaId);
  if (fromDb) {
    return fromDb;
  }
  if (await hasStaffFilmography(ctx.db, vaId)) {
    return [];
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
  // Favourites imports also take the scrape lock — fetch one type at a time.
  const characters = await fetchFavouriteCharacters(username, signal, fetchOptions);
  signal?.throwIfAborted();
  const favouriteStaff = await fetchFavouriteStaff(username, signal, fetchOptions);

  if (characters.length === 0) {
    throw new Error('This user has no favourite characters.');
  }

  const graphOptions = favouritesGraphForceOptions(fetchOptions);
  await ensureCharacterMediaFreshBatch(
    characters.map((character) => character.id),
    graphOptions,
  );

  const perCharacterVas: Array<
    Array<{
      id: number;
      name: string;
      imageUrl: string | null;
      gender: string | null;
    }>
  > = [];
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

    const edges = await readCharacterVoiceEdgesCached(character.id, signal);
    perCharacterEdges.push(edges);
    const processed = processCharacterEdges(
      character,
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
  const vaMainRoleCharacterCounts = new Map<number, number>();
  const vaIdList = [...vaIds];
  await ensureStaffFilmographyFreshBatch(vaIdList, graphOptions);
  for (let i = 0; i < vaIdList.length; i += 1) {
    signal?.throwIfAborted();
    const vaId = vaIdList[i]!;
    onProgress({ phase: 'va-totals', index: i + 1, total: vaIdList.length });
    const edges = await readVaCharacterEdgesCached(vaId, signal);
    const ctx = getToolsImportContext();
    vaTotalCharacterCounts.set(
      vaId,
      countVaCharactersOnMedia(edges, consumedMediaIds, 'all'),
    );
    vaMainRoleCharacterCounts.set(
      vaId,
      await countVaMainRoleCharactersOnConsumedMediaFromDb(
        ctx.db,
        vaId,
        consumedMediaIds,
      ),
    );
  }

  if (fetchOptions?.expandRoles) {
    const staffToExpand = favouriteStaff
      .map((staff) => staff.id)
      .filter((staffId) => !vaIds.has(staffId));
    if (staffToExpand.length > 0) {
      onProgress({
        phase: 'expand-staff-filmography',
        index: 1,
        total: staffToExpand.length,
      });
      await ensureStaffFilmographyFreshBatch(staffToExpand, graphOptions);
    }
  }

  onProgress({ phase: 'build' });
  const rebuildSource: FavouritesRebuildSource = {
    characters,
    perCharacterEdges,
    consumedMediaIds,
    favouriteStaff,
    vaTotalCharacterCounts,
    vaMainRoleCharacterCounts,
  };
  return {
    result: buildFavouritesResult({
      characters,
      perCharacterVas,
      perCharacterMeta,
      vaTotalCharacterCounts,
      vaMainRoleCharacterCounts,
      favouriteStaff,
    }),
    rebuildSource,
  };
}
