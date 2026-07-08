import {
  TOOLS_MEDIA_SEARCH_QUERY,
} from '../../lib/importers/anilist/queries';
import {
  fetchToolsMediaRelationsCached,
  type ToolsApiMedia,
} from '../../lib/importers/anilist/toolsMediaRelationsApi';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import {
  withSessionMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  ensureUserMediaListFresh,
  readUserMediaListEntriesFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
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

function mediaToNode(media: ToolsApiMedia): FranchiseNode {
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

function toFranchiseRelationsResponse(
  parsed: NonNullable<Awaited<ReturnType<typeof fetchToolsMediaRelationsCached>>>,
): FranchiseRelationsResponse {
  return {
    self: mediaToNode(parsed.media),
    edges: parsed.edges.map((edge) => ({
      relationType: edge.relationType,
      node: mediaToNode(edge.node),
    })),
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

async function fetchFranchiseRelations(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<FranchiseRelationsResponse | null> {
  const parsed = await fetchToolsMediaRelationsCached(mediaId, signal, options);
  return parsed ? toFranchiseRelationsResponse(parsed) : null;
}

type UserListEntry = { mediaId: number; status: string | null; score: number | null };

/**
 * DB-first read of the user's list for a given media type. Used to be a
 * live AniList depaginate that was thrown away after each Trace (only
 * a 15-min session memo) — meaning every revisit re-paid the cost of
 * both anime + manga list fetches. Now we go through the same shared
 * `media_list_entry` cache the other tools use:
 *   - `ensureUserMediaListFresh` is idempotent: no-op when the user's
 *     list was imported <90d ago, else runs a full import + persists.
 *   - `readUserMediaListEntriesFromDb` returns rows directly with
 *     status + score so we can stamp watched/scored onto franchise
 *     nodes without a network round trip.
 * Force-refresh threads through `ensureUserMediaListFresh` and re-runs
 * the AniList import.
 */
async function fetchUserMediaList(
  username: string,
  type: 'ANIME' | 'MANGA',
  _signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<UserListEntry[]> {
  const user = await ensureUserMediaListFresh(username, type, options);
  if (!user) {
    return [];
  }
  const ctx = getToolsImportContext();
  const rows = await readUserMediaListEntriesFromDb(ctx.db, user.id, type);
  return rows.map((row) => ({
    mediaId: row.mediaId,
    status: row.status,
    // AniList POINT_100 0 = "not rated"; normalize so franchise label
    // logic doesn't render a 0 cell.
    score: normalizeSeasonalListScore(row.score),
  }));
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
