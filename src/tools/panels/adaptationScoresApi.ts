import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  buildBatchedToolsMediaRelationsQuery,
  fetchToolsMediaRelationsBatch,
  type ToolsApiMedia,
  type ToolsMediaRelationsResponse,
} from '../../lib/importers/anilist/toolsMediaRelationsApi';
import {
  ensureUserMediaListFresh,
  readUserMediaListEntriesFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import { pickMediaTitle } from './sharedCreditsLogic';
import { normalizeSeasonalListScore } from './seasonalScoresLogic';
import {
  ADAPTATION_EDGE_TYPES,
  buildAdaptationDisplay,
  dedupeAdaptationPairs,
  normalizeAdaptationPair,
  type AdaptationDate,
  type AdaptationFilters,
  type AdaptationListScope,
  type AdaptationMedia,
  type AdaptationPair,
  type AdaptationScoresResult,
} from './adaptationScoresLogic';

export type { ToolsMediaRelationsResponse as AdaptationRelationsResponse };

function toAdaptationDate(
  raw?: { year?: number | null; month?: number | null; day?: number | null } | null,
): AdaptationDate {
  return {
    year: raw?.year ?? null,
    month: raw?.month ?? null,
    day: raw?.day ?? null,
  };
}

function apiMediaToStub(
  media: ToolsApiMedia,
  listStamp?: {
    status: string | null;
    score: number | null;
    startedAt: AdaptationDate | null;
  },
): AdaptationMedia {
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
    startDate: toAdaptationDate(media.startDate),
    listStatus: listStamp?.status ?? null,
    score: listStamp?.score ?? null,
    startedAt: listStamp?.startedAt ?? null,
  };
}

export function adaptationEdgesFromResponse(
  response: ToolsMediaRelationsResponse,
): ToolsMediaRelationsResponse['edges'] {
  return response.edges.filter((edge) =>
    (ADAPTATION_EDGE_TYPES as readonly string[]).includes(edge.relationType),
  );
}

export { buildBatchedToolsMediaRelationsQuery as buildBatchedAdaptationRelationsQuery };

type UserListEntry = {
  mediaId: number;
  status: string | null;
  score: number | null;
  startedAt: AdaptationDate | null;
};

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
    score: normalizeSeasonalListScore(row.score),
    startedAt:
      row.startedYear != null
        ? {
            year: row.startedYear,
            month: row.startedMonth,
            day: row.startedDay,
          }
        : null,
  }));
}

export type AdaptationRunProgress =
  | { phase: 'list'; mediaType: 'ANIME' | 'MANGA' }
  | { phase: 'relations'; done: number; total: number; title: string };

export type RunAdaptationScoresOptions = {
  username: string;
  filters: AdaptationFilters;
  signal?: AbortSignal;
  onProgress?: (progress: AdaptationRunProgress) => void;
  fetchOptions?: ToolsFetchOptions;
};

export type RunAdaptationScoresResult = AdaptationScoresResult;

export type AdaptationScanData = {
  pairs: AdaptationPair[];
  mediaMap: Map<number, AdaptationMedia>;
  listScope: AdaptationListScope;
};

export type RunAdaptationScoresOutput = {
  display: AdaptationScoresResult;
  scan: AdaptationScanData;
};

export function pairsFromRelationScan(
  listMediaIds: readonly number[],
  responses: ReadonlyMap<number, ToolsMediaRelationsResponse>,
): AdaptationPair[] {
  const pairs: AdaptationPair[] = [];
  for (const listMediaId of listMediaIds) {
    const response = responses.get(listMediaId);
    if (!response) {
      continue;
    }
    for (const edge of adaptationEdgesFromResponse(response)) {
      const pair = normalizeAdaptationPair(
        listMediaId,
        edge.relationType,
        edge.node.id,
      );
      if (pair) {
        pairs.push(pair);
      }
    }
  }
  return dedupeAdaptationPairs(pairs);
}

export function buildAdaptationMediaMap(
  listEntries: readonly UserListEntry[],
  responses: ReadonlyMap<number, ToolsMediaRelationsResponse>,
): Map<number, AdaptationMedia> {
  const listStamp = new Map(
    listEntries.map((entry) => [
      entry.mediaId,
      {
        status: entry.status,
        score: entry.score,
        startedAt: entry.startedAt,
      },
    ]),
  );

  const mediaMap = new Map<number, AdaptationMedia>();

  const ingest = (media: ToolsApiMedia) => {
    if (mediaMap.has(media.id)) {
      return;
    }
    mediaMap.set(media.id, apiMediaToStub(media, listStamp.get(media.id)));
  };

  for (const response of responses.values()) {
    ingest(response.media);
    for (const edge of adaptationEdgesFromResponse(response)) {
      ingest(edge.node);
    }
  }

  return mediaMap;
}

function buildAdaptationListScope(
  animeList: readonly UserListEntry[],
  mangaList: readonly UserListEntry[],
): AdaptationListScope {
  return {
    animeListIds: new Set(animeList.map((entry) => entry.mediaId)),
    mangaListIds: new Set(mangaList.map((entry) => entry.mediaId)),
  };
}

export async function runAdaptationScores(
  options: RunAdaptationScoresOptions,
): Promise<RunAdaptationScoresOutput> {
  const { username, filters, signal, onProgress, fetchOptions } = options;

  signal?.throwIfAborted();
  onProgress?.({ phase: 'list', mediaType: 'ANIME' });
  const animeList = await fetchUserMediaList(username, 'ANIME', signal, fetchOptions);
  onProgress?.({ phase: 'list', mediaType: 'MANGA' });
  const mangaList = await fetchUserMediaList(username, 'MANGA', signal, fetchOptions);
  const listScope = buildAdaptationListScope(animeList, mangaList);

  const listEntries = [...animeList, ...mangaList];
  const listMediaIds = listEntries.map((entry) => entry.mediaId);

  if (listMediaIds.length === 0) {
    return {
      display: { kind: 'empty', message: 'No list entries to scan for adaptations.' },
      scan: {
        pairs: [],
        mediaMap: new Map(),
        listScope: { animeListIds: new Set(), mangaListIds: new Set() },
      },
    };
  }

  let done = 0;
  const responses = await fetchToolsMediaRelationsBatch(listMediaIds, {
    signal,
    fetchOptions,
    onItem: (response) => {
      done++;
      onProgress?.({
        phase: 'relations',
        done,
        total: listMediaIds.length,
        title: pickMediaTitle(response.media.title),
      });
    },
  });

  const pairs = pairsFromRelationScan(listMediaIds, responses);
  if (pairs.length === 0) {
    return {
      display: {
        kind: 'empty',
        message: 'No SOURCE/ADAPTATION relations found on your list items.',
      },
      scan: {
        pairs: [],
        mediaMap: buildAdaptationMediaMap(listEntries, responses),
        listScope,
      },
    };
  }

  const mediaMap = buildAdaptationMediaMap(listEntries, responses);
  return {
    display: buildAdaptationDisplay(pairs, mediaMap, listScope, filters),
    scan: { pairs, mediaMap, listScope },
  };
}
