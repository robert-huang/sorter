import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_FRANCHISE_RELATIONS_QUERY,
  TOOLS_MEDIA_SEARCH_QUERY,
  TOOLS_USER_MEDIA_LIST_MINIMAL_QUERY,
} from '../../lib/importers/anilist/queries';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import {
  TOOLS_SESSION_TTL_MS,
  withSessionMemo,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import { pickMediaTitle } from './sharedCreditsLogic';
import { normalizeSeasonalListScore } from './seasonalScoresLogic';
import {
  bfsFranchiseRelations,
  buildFranchiseEntries,
  DEFAULT_RELATION_TOGGLES,
  type FranchiseEntry,
  type FranchiseNode,
  type FranchiseRelationType,
  type FranchiseRelationsResponse,
} from './franchiseScoresLogic';

type ApiMedia = {
  id: number;
  type?: 'ANIME' | 'MANGA' | null;
  format?: string | null;
  title: { english?: string | null; romaji?: string | null; native?: string | null };
  coverImage?: { large?: string | null } | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
};

function mediaToNode(media: ApiMedia): FranchiseNode {
  return {
    id: media.id,
    mediaType: media.type === 'MANGA' ? 'MANGA' : 'ANIME',
    format: media.format ?? null,
    title: pickMediaTitle(media.title),
    titleSource: {
      id: media.id,
      title_english: media.title.english ?? null,
      title_romaji: media.title.romaji ?? null,
      title_native: media.title.native ?? null,
    },
    coverImage: media.coverImage?.large ?? null,
    startDate: {
      year: media.startDate?.year ?? null,
      month: media.startDate?.month ?? null,
      day: media.startDate?.day ?? null,
    },
  };
}

/** Resolve a free-text show title to its anime media id. */
export async function searchFranchiseSeed(
  search: string,
  signal?: AbortSignal,
): Promise<{ id: number; title: string }> {
  signal?.throwIfAborted();
  const cacheKey = `tools:franchise:seed-search:${search.toLowerCase()}`;
  return withSessionMemo(cacheKey, async () => {
    const data = await executeAnilistQuery<{
      Media: {
        id: number;
        title: { english?: string | null; romaji?: string | null };
      } | null;
    }>(TOOLS_MEDIA_SEARCH_QUERY, { search, sort: ['POPULARITY_DESC'] });
    if (!data?.Media?.id) {
      throw new Error(`Could not find show matching "${search}".`);
    }
    return {
      id: data.Media.id,
      title: pickMediaTitle(data.Media.title),
    };
  });
}

async function fetchFranchiseRelationsLive(
  mediaId: number,
  signal?: AbortSignal,
): Promise<FranchiseRelationsResponse | null> {
  signal?.throwIfAborted();
  const data = await executeAnilistQuery<{
    Media: (ApiMedia & {
      relations?: {
        edges: Array<{
          relationType?: string | null;
          node: ApiMedia;
        }>;
      } | null;
    }) | null;
  }>(TOOLS_FRANCHISE_RELATIONS_QUERY, { mediaId });
  if (!data?.Media) {
    return null;
  }
  const self = mediaToNode(data.Media);
  const edges = (data.Media.relations?.edges ?? [])
    .filter((edge) => edge.node?.id != null)
    .map((edge) => ({
      relationType: (edge.relationType ?? 'OTHER').trim() || 'OTHER',
      node: mediaToNode(edge.node),
    }));
  return { self, edges };
}

function fetchFranchiseRelations(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<FranchiseRelationsResponse | null> {
  signal?.throwIfAborted();
  return withSessionTtlMemo(
    `franchise:relations:${mediaId}`,
    TOOLS_SESSION_TTL_MS,
    () => fetchFranchiseRelationsLive(mediaId, signal),
    { bust: options?.forceRefresh },
  );
}

type UserListEntry = { mediaId: number; status: string | null; score: number | null };

async function fetchUserMediaListLive(
  username: string,
  type: 'ANIME' | 'MANGA',
  signal?: AbortSignal,
): Promise<UserListEntry[]> {
  signal?.throwIfAborted();
  const entries = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        mediaList: Array<{
          mediaId: number;
          status?: string | null;
          score?: number | null;
        }>;
      } | null;
    },
    { mediaId: number; status?: string | null; score?: number | null }
  >({
    query: TOOLS_USER_MEDIA_LIST_MINIMAL_QUERY,
    variables: { userName: username, type },
    signal,
    selectPage: (data) => ({
      nodes: data.Page?.mediaList ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });
  return entries.map((entry) => ({
    mediaId: entry.mediaId,
    status: entry.status ?? null,
    score: normalizeSeasonalListScore(entry.score ?? null),
  }));
}

function fetchUserMediaList(
  username: string,
  type: 'ANIME' | 'MANGA',
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<UserListEntry[]> {
  const handle = username.trim().toLowerCase();
  return withSessionTtlMemo(
    `franchise:list:${handle}:${type}`,
    TOOLS_SESSION_TTL_MS,
    () => fetchUserMediaListLive(username, type, signal),
    { bust: options?.forceRefresh },
  );
}

export type FranchiseRunProgress =
  | { phase: 'resolve'; label: string }
  | { phase: 'walk'; visited: number; queueDepth: number; lastTitle: string }
  | { phase: 'list'; mediaType: 'ANIME' | 'MANGA' };

export type RunFranchiseScoresOptions = {
  seedSearch: string;
  username: string;
  relationToggles?: Record<FranchiseRelationType, boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: FranchiseRunProgress) => void;
  fetchOptions?: ToolsFetchOptions;
  /** Cap on franchise nodes — guards a runaway OTHER web. */
  maxNodes?: number;
};

export type RunFranchiseScoresResult = {
  seed: { id: number; title: string };
  entries: FranchiseEntry[];
};

/**
 * Full run: resolve seed → BFS relations → fetch anime + manga user lists →
 * stamp watched/score onto each node → sort by release date. The panel just
 * dumps the result into the chart.
 */
export async function runFranchiseScores(
  options: RunFranchiseScoresOptions,
): Promise<RunFranchiseScoresResult> {
  const {
    seedSearch,
    username,
    relationToggles = DEFAULT_RELATION_TOGGLES,
    signal,
    onProgress,
    fetchOptions,
    maxNodes,
  } = options;

  signal?.throwIfAborted();
  onProgress?.({ phase: 'resolve', label: seedSearch });
  const seed = await searchFranchiseSeed(seedSearch, signal);

  const nodes = await bfsFranchiseRelations(
    seed.id,
    relationToggles,
    (id, sig) => fetchFranchiseRelations(id, sig, fetchOptions),
    {
      signal,
      maxNodes,
      onProgress: (info) => onProgress?.({ phase: 'walk', ...info }),
    },
  );

  onProgress?.({ phase: 'list', mediaType: 'ANIME' });
  const animeList = await fetchUserMediaList(username, 'ANIME', signal, fetchOptions);
  onProgress?.({ phase: 'list', mediaType: 'MANGA' });
  const mangaList = await fetchUserMediaList(username, 'MANGA', signal, fetchOptions);

  const listMap = new Map<number, { status: string | null; score: number | null }>();
  for (const entry of [...animeList, ...mangaList]) {
    listMap.set(entry.mediaId, { status: entry.status, score: entry.score });
  }

  const entries = buildFranchiseEntries(seed.id, nodes, listMap);
  return { seed, entries };
}
