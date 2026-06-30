import { depaginate, depaginateWithMeta } from '../../lib/importers/anilist/depaginate';
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
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import {
  ensureCharacterMediaFresh,
  ensureStaffFilmographyFresh,
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
 * Cap on the defensive live fallback when the DB read returns nothing
 * AFTER `ensureCharacterMediaFresh` already ran (e.g. the AniList probe
 * said the character exists but the expansion produced zero rows for
 * some reason). Bounded to two pages so a corrupted-cache fallback
 * can't quietly hammer AniList on every Analyze run.
 */
const FAVOURITES_CHARACTER_MEDIA_MAX_PAGES = 2;

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

async function fetchConsumedMediaListLive(
  username: string,
  type: 'ANIME' | 'MANGA',
  signal?: AbortSignal,
): Promise<number[]> {
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
    variables: { userName: username, type },
    signal,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });
  return entries.map((e) => e.mediaId);
}

async function fetchConsumedMediaIds(
  username: string,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<Set<number>> {
  signal?.throwIfAborted();
  const importOptions = favouritesImportOptions(options);
  // List imports share the per-source AniList scrape lock — run sequentially
  // (same as the ↻ refresh button) so parallel ensure* calls don't race.
  const animeUser = await ensureUserAnimeListFresh(username, importOptions);
  signal?.throwIfAborted();
  const mangaUser = await ensureUserMangaListFresh(username, importOptions);
  const user = animeUser ?? mangaUser;
  if (user) {
    const ctx = getToolsImportContext();
    const fromDb = await readConsumedMediaIdsFromDb(ctx.db, user.id);
    if (fromDb) {
      return fromDb;
    }
  }

  const [animeIds, mangaIds] = await Promise.all([
    fetchConsumedMediaListLive(username, 'ANIME', signal),
    fetchConsumedMediaListLive(username, 'MANGA', signal),
  ]);
  return new Set([...animeIds, ...mangaIds]);
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
  // expandRoles is a deep-fetch path; bust the memo so we re-read the
  // (post-import) DB list instead of serving a pre-expandRoles cache.
  return withSessionTtlMemo(
    `fav:chars:${handle}`,
    FAVOURITES_SESSION_TTL_MS,
    () => fetchFavouriteCharactersFromDbOrLive(username, signal, options),
    { bust: !!(options?.forceRefreshFavourites || options?.expandRoles) },
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
    { bust: !!(options?.forceRefreshFavourites || options?.expandRoles) },
  );
}

async function fetchCharacterVoiceEdgesLive(
  charId: number,
  signal?: AbortSignal,
  maxPages?: number,
): Promise<{ edges: CharacterMediaEdge[]; truncated: boolean }> {
  const result = await depaginateWithMeta<
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
  return { edges: result.nodes, truncated: result.truncated };
}

async function fetchCharacterVoiceEdges(
  charId: number,
  signal?: AbortSignal,
  options?: FavouritesFetchOptions,
): Promise<{ edges: CharacterMediaEdge[]; truncated: boolean }> {
  signal?.throwIfAborted();
  const ctx = getToolsImportContext();

  // Single write-through path: ensureCharacterMediaFresh is idempotent
  // (no-op when character_media_expansion.fetched_at is <90d), runs a
  // full live expansion + persists otherwise, and force-refreshes on
  // Expand Roles. Then we read the complete cached rows from the DB.
  //
  // Previously Analyze had a DB freshness check that required every
  // appearance media's full cast to be pre-imported, which almost
  // never holds — so Analyze fell back to a 2-page live fetch that
  // was thrown away after each run. Result: every Analyze re-paid
  // the network cost for every favourite character forever.
  //
  // NOTE: ensureCharacterMediaFresh does not currently accept an
  // AbortSignal — see the cancel-related comment in
  // runFavouritesAnalysis below. throwIfAborted at entry bounds the
  // damage to one character at a time.
  await ensureCharacterMediaFresh(charId, favouritesGraphForceOptions(options));
  const fromDb = await readCharacterVoiceEdgesFromDb(ctx.db, charId);
  if (fromDb) {
    return { edges: fromDb, truncated: false };
  }
  // Defensive fallback: expansion ran but the DB read came back empty
  // (very old schema, partial write, or character with no JP cast).
  // Cap the live fallback so a misbehaving cache doesn't quietly do an
  // unbounded fetch on every Analyze run.
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

  // Same write-through pattern as fetchCharacterVoiceEdges above:
  // ensureStaffFilmographyFresh is a no-op when staff_filmography_
  // expansion is <90d, runs a full import + persists otherwise, and
  // force-refreshes on Expand Roles. Analyze used to skip the
  // persist and re-fetch every VA's full filmography on every run.
  //
  // NOTE: same AbortSignal caveat as fetchCharacterVoiceEdges.
  await ensureStaffFilmographyFresh(vaId, favouritesGraphForceOptions(options));
  const fromDb = await readVaCharacterEdgesFromDb(ctx.db, vaId);
  if (fromDb) {
    return fromDb;
  }
  // Defensive fallback when the DB read returns nothing despite a
  // successful ensure call (rare — e.g. staff with no JP voice roles).
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
  const consumedMediaIds = await fetchConsumedMediaIds(username, signal, fetchOptions);

  onProgress({ phase: 'characters' });
  // Favourites imports also take the scrape lock — fetch one type at a time.
  const characters = await fetchFavouriteCharacters(username, signal, fetchOptions);
  signal?.throwIfAborted();
  const favouriteStaff = await fetchFavouriteStaff(username, signal, fetchOptions);

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
  const truncatedCharacterIds = new Set<number>();
  const truncatedCharacterNames: string[] = [];

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

    const { edges, truncated } = await fetchCharacterVoiceEdges(
      character.id,
      signal,
      fetchOptions,
    );
    perCharacterEdges.push(edges);
    if (truncated) {
      truncatedCharacterIds.add(character.id);
      truncatedCharacterNames.push(charName);
    }
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
  const vaMainRoleCharacterCounts = new Map<number, number>();
  const vaIdList = [...vaIds];
  for (let i = 0; i < vaIdList.length; i += 1) {
    signal?.throwIfAborted();
    const vaId = vaIdList[i]!;
    onProgress({ phase: 'va-totals', index: i + 1, total: vaIdList.length });
    const edges = await fetchVaCharacterEdges(vaId, signal, fetchOptions);
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
    for (let i = 0; i < staffToExpand.length; i += 1) {
      signal?.throwIfAborted();
      const staffId = staffToExpand[i]!;
      onProgress({
        phase: 'expand-staff-filmography',
        index: i + 1,
        total: staffToExpand.length,
      });
      // NOTE: ensureStaffFilmographyFresh does not currently accept an
      // AbortSignal; an in-flight expansion can keep hitting AniList for
      // minutes after the user clicks Cancel. The between-iteration
      // throwIfAborted above bounds the damage to "one staff at a time"
      // but threading the signal down through the importer would be
      // strictly better. Same applies to ensureCharacterMediaFresh above.
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
    vaMainRoleCharacterCounts,
    ...(truncatedCharacterIds.size > 0 ? { truncatedCharacterIds } : {}),
  };
  return {
    result: buildFavouritesResult({
      characters,
      perCharacterVas,
      perCharacterMeta,
      vaTotalCharacterCounts,
      vaMainRoleCharacterCounts,
      favouriteStaff,
      ...(truncatedCharacterNames.length > 0 ? { truncatedCharacterNames } : {}),
    }),
    rebuildSource,
  };
}
