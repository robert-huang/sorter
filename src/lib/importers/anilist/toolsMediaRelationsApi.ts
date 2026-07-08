/**
 * Shared Media.relations fetch for tools. SQLite is the durable cache
 * (`media_relation` + `media_relations_expansion`); session memo only
 * dedupes concurrent in-tab requests.
 */

import type { SqlBindable } from './context';
import {
  getMediaRelationsExpansionFetchedAt,
  getMediaRelationsExpansionFetchedAtBatch,
  getToolsMediaRelationsFromDb,
  getToolsMediaRelationsFromDbBatch,
} from './graphQueries';
import { expandMediaRelations } from './expandMediaRelations';
import {
  TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS,
  TOOLS_MEDIA_RELATIONS_V2_QUERY,
} from './queries';
import { getToolsImportContext } from './toolsImportContext';
import { withSessionMemo } from './toolsSessionMemo';
import { executeAnilistQuery } from './transport';
import { needsGraphDataRefresh } from './toolsFetchPolicy';
import type { ToolsFetchOptions } from './toolsFetchPolicy';
import { mapMediaRow } from './mappers';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
import type { AnilistMediaGql, AnilistMediaRelationsResponse } from './types';

/** @deprecated Legacy localStorage TTL — kept for backfill age derivation only. */
export const TOOLS_MEDIA_RELATIONS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const TOOLS_MEDIA_RELATIONS_CACHE_PREFIX = 'tools:relations:v2:';

/** Pre-v2 unified cache keys — pruned once per session on first relation fetch. */
const LEGACY_TOOLS_RELATION_CACHE_PREFIXES = [
  'franchise:relations:',
  'adaptation:relations:',
] as const;

import { persistentCacheDelete, persistentCacheDeletePrefix, persistentCacheGet } from './toolsPersistentCache';

let legacyRelationCachesPruned = false;

function pruneLegacyToolsRelationCaches(): void {
  if (legacyRelationCachesPruned) {
    return;
  }
  legacyRelationCachesPruned = true;
  for (const prefix of LEGACY_TOOLS_RELATION_CACHE_PREFIXES) {
    persistentCacheDeletePrefix(prefix);
  }
}

export function toolsMediaRelationsCacheKey(mediaId: number): string {
  return `${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}${mediaId}`;
}

export type ToolsApiMedia = {
  id: number;
  type?: 'ANIME' | 'MANGA' | null;
  format?: string | null;
  title: { english?: string | null; romaji?: string | null; native?: string | null };
  coverImage?: { large?: string | null } | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  relations?: {
    edges: Array<{
      relationType?: string | null;
      node: ToolsApiMedia;
    }>;
  } | null;
};

export type ToolsMediaRelationsResponse = {
  media: ToolsApiMedia;
  edges: Array<{ relationType: string; node: ToolsApiMedia }>;
};

export function normalizeToolsRelationType(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase() || 'OTHER';
}

/** Parse a live GraphQL Media node into media + all v2 relation edges. */
export function parseToolsMediaRelations(
  media: ToolsApiMedia | null | undefined,
): ToolsMediaRelationsResponse | null {
  if (!media?.id) {
    return null;
  }
  const edges = (media.relations?.edges ?? [])
    .filter((edge) => edge.node?.id != null)
    .map((edge) => ({
      relationType: normalizeToolsRelationType(edge.relationType),
      node: edge.node,
    }));
  return { media, edges };
}

function toAnilistRelationsResponse(
  media: ToolsApiMedia | null,
): AnilistMediaRelationsResponse | null {
  if (!media?.id) {
    return null;
  }
  return {
    Media: {
      ...toolsApiMediaToGql(media),
      relations: {
        edges: (media.relations?.edges ?? [])
          .filter((edge) => edge.node?.id != null)
          .map((edge) => ({
            relationType: edge.relationType ?? 'OTHER',
            node: edge.node as never,
          })),
      },
    },
  };
}

export async function fetchToolsMediaRelationsLive(
  mediaId: number,
  signal?: AbortSignal,
): Promise<ToolsMediaRelationsResponse | null> {
  signal?.throwIfAborted();
  const data = await executeAnilistQuery<{ Media: ToolsApiMedia | null }>(
    TOOLS_MEDIA_RELATIONS_V2_QUERY,
    { mediaId },
  );
  return parseToolsMediaRelations(data?.Media ?? null);
}

async function fetchAndPersistToolsMediaRelations(
  mediaId: number,
  signal?: AbortSignal,
  force = false,
): Promise<ToolsMediaRelationsResponse | null> {
  signal?.throwIfAborted();
  const live = await fetchToolsMediaRelationsLive(mediaId, signal);
  if (!live) {
    return null;
  }
  const ctx = getToolsImportContext();
  const gqlResponse = toAnilistRelationsResponse(live.media);
  if (!gqlResponse) {
    return null;
  }
  await expandMediaRelations(ctx, mediaId, {
    force,
    response: gqlResponse,
  });
  return getToolsMediaRelationsFromDb(ctx.db, mediaId);
}

export function fetchToolsMediaRelationsCached(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<ToolsMediaRelationsResponse | null> {
  pruneLegacyToolsRelationCaches();
  signal?.throwIfAborted();
  const key = toolsMediaRelationsCacheKey(mediaId);
  return withSessionMemo(
    key,
    async () => {
      const ctx = getToolsImportContext();
      await backfillToolsRelationsFromLocalStorage();
      const fetchedAt = await getMediaRelationsExpansionFetchedAt(ctx.db, mediaId);
      if (!needsGraphDataRefresh(fetchedAt, options)) {
        return getToolsMediaRelationsFromDb(ctx.db, mediaId);
      }
      return fetchAndPersistToolsMediaRelations(
        mediaId,
        signal,
        options?.forceRefresh ?? false,
      );
    },
    options,
  );
}

export function buildBatchedToolsMediaRelationsQuery(
  mediaIds: readonly number[],
): { query: string; variables: Record<string, number> } {
  const variables: Record<string, number> = {};
  const fields = mediaIds
    .map((id, index) => {
      variables[`id${index}`] = id;
      return `m${index}: Media(id: $id${index}) {
    ${TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS}
  }`;
    })
    .join('\n');
  const varDefs = mediaIds.map((_, index) => `$id${index}: Int!`).join(', ');
  const query = `query ToolsMediaRelationsV2Batch(${varDefs}) {
${fields}
}`;
  return { query, variables };
}

export type FetchToolsMediaRelationsBatchOptions = {
  signal?: AbortSignal;
  fetchOptions?: ToolsFetchOptions;
  batchSize?: number;
  onItem?: (response: ToolsMediaRelationsResponse) => void;
};

/**
 * Fetch relations for many list seeds. Reads fresh SQLite rows first,
 * then live-fetches only missing/stale ids (or all when forceRefresh).
 */
export async function fetchToolsMediaRelationsBatch(
  mediaIds: readonly number[],
  options: FetchToolsMediaRelationsBatchOptions = {},
): Promise<Map<number, ToolsMediaRelationsResponse>> {
  pruneLegacyToolsRelationCaches();
  const { signal, fetchOptions, onItem } = options;
  const batchSize = options.batchSize ?? 15;
  const out = new Map<number, ToolsMediaRelationsResponse>();
  const ctx = getToolsImportContext();
  await backfillToolsRelationsFromLocalStorage();

  const forceAll = fetchOptions?.forceRefresh ?? false;
  const markerMap = await getMediaRelationsExpansionFetchedAtBatch(ctx.db, mediaIds);
  const pending: number[] = [];

  for (const mediaId of mediaIds) {
    if (forceAll || needsGraphDataRefresh(markerMap.get(mediaId) ?? null, fetchOptions)) {
      pending.push(mediaId);
      continue;
    }
  }

  const freshIds = mediaIds.filter((id) => !pending.includes(id));
  if (freshIds.length > 0) {
    const cached = await getToolsMediaRelationsFromDbBatch(ctx.db, freshIds);
    for (const [id, response] of cached) {
      out.set(id, response);
      onItem?.(response);
    }
  }

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    signal?.throwIfAborted();
    const chunk = pending.slice(offset, offset + batchSize);
    if (chunk.length === 0) {
      continue;
    }
    try {
      const { query, variables } = buildBatchedToolsMediaRelationsQuery(chunk);
      const data = await executeAnilistQuery<Record<string, ToolsApiMedia | null>>(
        query,
        variables,
      );
      for (let i = 0; i < chunk.length; i++) {
        const mediaId = chunk[i]!;
        const parsed = parseToolsMediaRelations(data?.[`m${i}`] ?? null);
        if (!parsed) {
          continue;
        }
        const gqlResponse = toAnilistRelationsResponse(parsed.media);
        if (!gqlResponse) {
          continue;
        }
        await expandMediaRelations(ctx, mediaId, {
          force: forceAll,
          response: gqlResponse,
        });
      }
    } catch {
      for (const mediaId of chunk) {
        const parsed = await fetchAndPersistToolsMediaRelations(
          mediaId,
          signal,
          forceAll,
        );
        if (parsed) {
          out.set(mediaId, parsed);
          onItem?.(parsed);
        }
      }
      continue;
    }

    const written = await getToolsMediaRelationsFromDbBatch(ctx.db, chunk);
    for (const [id, response] of written) {
      out.set(id, response);
      onItem?.(response);
    }
  }

  return out;
}

let backfillDone = false;

function toolsApiMediaToGql(media: ToolsApiMedia): AnilistMediaGql {
  return {
    id: media.id,
    type: media.type ?? 'ANIME',
    format: (media.format ?? null) as AnilistMediaGql['format'],
    title: {
      english: media.title.english ?? null,
      romaji: media.title.romaji ?? null,
      native: media.title.native ?? null,
    },
    coverImage: media.coverImage?.large
      ? { large: media.coverImage.large }
      : null,
    startDate: {
      year: media.startDate?.year ?? null,
      month: media.startDate?.month ?? null,
      day: media.startDate?.day ?? null,
    },
    endDate: null,
    season: null,
    seasonYear: null,
    status: null,
    episodes: null,
    chapters: null,
    meanScore: null,
    favourites: null,
    countryOfOrigin: null,
    genres: null,
    synonyms: null,
    source: null,
    studios: null,
    tags: null,
  };
}

function listLegacyRelationCacheKeys(): string[] {
  const prefix = `tools-cache:${TOOLS_MEDIA_RELATIONS_CACHE_PREFIX}`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(prefix)) {
        keys.push(key.slice('tools-cache:'.length));
      }
    }
  } catch {
    /* ignore */
  }
  return keys;
}

async function writeCachedRelationsToDb(
  mediaId: number,
  parsed: ToolsMediaRelationsResponse,
  fetchedAt: number,
): Promise<void> {
  const ctx = getToolsImportContext();
  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];
  const mediaById = new Map<number, ReturnType<typeof mapMediaRow>>();

  mediaById.set(mediaId, mapMediaRow(toolsApiMediaToGql(parsed.media), fetchedAt));
  for (const edge of parsed.edges) {
    const toId = edge.node.id;
    if (!mediaById.has(toId)) {
      mediaById.set(toId, mapMediaRow(toolsApiMediaToGql(edge.node), fetchedAt));
    }
  }

  for (const row of mediaById.values()) {
    stmts.push({ sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(row) });
  }

  for (const edge of parsed.edges) {
    const toId = edge.node.id;
    const relationType = normalizeToolsRelationType(edge.relationType);
    stmts.push({
      sql: `INSERT OR IGNORE INTO media_relation (from_media_id, to_media_id, relation_type)
            VALUES (?, ?, ?)`,
      params: [mediaId, toId, relationType],
    });
  }

  stmts.push({
    sql: `INSERT INTO media_relations_expansion (media_id, fetched_at)
          VALUES (?, ?)
          ON CONFLICT(media_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
    params: [mediaId, fetchedAt],
  });

  await ctx.db.execBatch(stmts);
}

/** Idempotent per session — skips ids that already have a SQLite marker. */
async function backfillToolsRelationsFromLocalStorage(): Promise<number> {
  if (backfillDone) {
    return 0;
  }
  backfillDone = true;

  const ctx = getToolsImportContext();
  let migrated = 0;
  for (const cacheKey of listLegacyRelationCacheKeys()) {
    const mediaId = Number.parseInt(
      cacheKey.slice(TOOLS_MEDIA_RELATIONS_CACHE_PREFIX.length),
      10,
    );
    if (!Number.isFinite(mediaId)) {
      continue;
    }
    if ((await getMediaRelationsExpansionFetchedAt(ctx.db, mediaId)) !== null) {
      persistentCacheDelete(cacheKey);
      continue;
    }
    const hit = persistentCacheGet<ToolsMediaRelationsResponse>(cacheKey);
    if (!hit.hit || !hit.value?.media?.id) {
      continue;
    }
    const fetchedAt = Date.now();
    await writeCachedRelationsToDb(mediaId, hit.value, fetchedAt);
    persistentCacheDelete(cacheKey);
    migrated++;
  }
  return migrated;
}

/** Test-only reset. */
export function _resetToolsRelationsBackfillForTesting(): void {
  backfillDone = false;
}
