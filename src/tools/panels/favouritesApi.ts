import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
  TOOLS_FAVOURITE_CHARACTERS_QUERY,
  TOOLS_FAVOURITE_STAFF_QUERY,
  TOOLS_USER_CONSUMED_MEDIA_QUERY,
  TOOLS_VA_CHARACTER_MEDIA_QUERY,
} from '../../lib/importers/anilist/queries';
import { TOOLS_CACHE_TTL_MS, withToolsCache } from '../../lib/importers/anilist/toolsCache';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import { ensureUserAnimeListFresh } from '../../lib/importers/anilist/toolsAnilistAccess';
import {
  buildFavouritesResult,
  countVaCharactersOnMedia,
  processCharacterEdges,
  type CharacterMediaEdge,
  type CharacterRoleTier,
  type FavouriteCharacterInput,
  type FavouriteStaffInput,
  type FavouritesForm,
  type FavouritesResult,
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
  const cacheKey = `tools:consumed-media:${username.toLowerCase()}`;
  const ids = await withToolsCache(
    cacheKey,
    TOOLS_CACHE_TTL_MS.userList,
    async () => {
      await ensureUserAnimeListFresh(username, options);
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
    return entries.map((e) => e.mediaId);
    },
    options,
  );
  return new Set(ids);
}

async function fetchFavouriteCharacters(
  username: string,
  signal?: AbortSignal,
): Promise<FavouriteCharacterInput[]> {
  signal?.throwIfAborted();
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

async function fetchFavouriteStaff(
  username: string,
  signal?: AbortSignal,
): Promise<FavouriteStaffInput[]> {
  signal?.throwIfAborted();
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

async function fetchCharacterVoiceEdges(
  charId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<CharacterMediaEdge[]> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:character-vas:${charId}`,
    TOOLS_CACHE_TTL_MS.characterVa,
    async () =>
      depaginate<
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
      }),
    options,
  );
}

async function fetchVaCharacterEdges(
  vaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<VaMediaEdge[]> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:va-characters:${vaId}`,
    TOOLS_CACHE_TTL_MS.characterVa,
    async () =>
      depaginate<
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
      }),
    options,
  );
}

export async function runFavouritesAnalysis(
  form: FavouritesForm,
  onProgress: (progress: FavouritesRunProgress) => void,
  signal?: AbortSignal,
  fetchOptions?: ToolsFetchOptions,
): Promise<FavouritesResult> {
  const username = form.username.trim();
  onProgress({ phase: 'list' });
  const consumedMediaIds = await fetchConsumedMediaIds(username, signal, fetchOptions);

  onProgress({ phase: 'characters' });
  const [characters, favouriteStaff] = await Promise.all([
    fetchFavouriteCharacters(username, signal),
    fetchFavouriteStaff(username, signal),
  ]);

  if (characters.length === 0) {
    throw new Error('This user has no favourite characters.');
  }

  const perCharacterVas: Array<Array<{ id: number; name: string }>> = [];
  const perCharacterMeta: Array<{
    charRole: CharacterRoleTier;
    seen: boolean;
    isMain: boolean;
    shows: Record<string, string[]>;
    books: Record<string, string[]>;
  }> = [];
  const vaIds = new Set<number>();

  for (let i = 0; i < characters.length; i += 1) {
    signal?.throwIfAborted();
    const character = characters[i];
    const charName =
      form.useEnglishNames || !character.name.native
        ? character.name.full
        : character.name.native;

    onProgress({
      phase: 'character-vas',
      index: i + 1,
      total: characters.length,
      name: charName,
    });

    const edges = await fetchCharacterVoiceEdges(character.id, signal, fetchOptions);
    const processed = processCharacterEdges(
      character.id,
      charName,
      edges,
      consumedMediaIds,
      form.useEnglishNames,
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
    const vaId = vaIdList[i];
    onProgress({ phase: 'va-totals', index: i + 1, total: vaIdList.length });
    const edges = await fetchVaCharacterEdges(vaId, signal, fetchOptions);
    vaTotalCharacterCounts.set(vaId, countVaCharactersOnMedia(edges, consumedMediaIds));
  }

  onProgress({ phase: 'build' });
  return buildFavouritesResult({
    characters,
    perCharacterVas,
    perCharacterMeta,
    vaTotalCharacterCounts,
    favouriteStaff,
    useEnglish: form.useEnglishNames,
  });
}
