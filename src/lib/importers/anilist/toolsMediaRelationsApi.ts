/**
 * Shared Media.relations fetch + cross-session cache for tools.
 * All relation walks use MediaRelation v2 (`relationType(version: 2)`).
 * Franchise Scores, Adaptation Scores, and future tools share one cache
 * key per media id so a compare in one tool warms the other.
 */

import {
  TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS,
  TOOLS_MEDIA_RELATIONS_V2_QUERY,
} from './queries';
import { executeAnilistQuery } from './transport';
import { withSessionTtlMemo } from './toolsSessionMemo';
import { withPersistentTtlCache, persistentCacheDeletePrefix } from './toolsPersistentCache';
import type { ToolsFetchOptions } from './toolsFetchPolicy';

export const TOOLS_MEDIA_RELATIONS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const TOOLS_MEDIA_RELATIONS_CACHE_PREFIX = 'tools:relations:v2:';

/** Pre-v2 unified cache keys — pruned once per session on first relation fetch. */
const LEGACY_TOOLS_RELATION_CACHE_PREFIXES = [
  'franchise:relations:',
  'adaptation:relations:',
] as const;

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

export function fetchToolsMediaRelationsCached(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<ToolsMediaRelationsResponse | null> {
  pruneLegacyToolsRelationCaches();
  signal?.throwIfAborted();
  const key = toolsMediaRelationsCacheKey(mediaId);
  return withSessionTtlMemo(
    key,
    TOOLS_MEDIA_RELATIONS_TTL_MS,
    () =>
      withPersistentTtlCache(
        key,
        TOOLS_MEDIA_RELATIONS_TTL_MS,
        () => fetchToolsMediaRelationsLive(mediaId, signal),
        { bust: options?.forceRefresh },
      ),
    { bust: options?.forceRefresh },
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

async function persistToolsMediaRelationsCache(
  mediaId: number,
  parsed: ToolsMediaRelationsResponse,
): Promise<void> {
  const key = toolsMediaRelationsCacheKey(mediaId);
  await withPersistentTtlCache(
    key,
    TOOLS_MEDIA_RELATIONS_TTL_MS,
    async () => parsed,
    { bust: false },
  );
}

export type FetchToolsMediaRelationsBatchOptions = {
  signal?: AbortSignal;
  fetchOptions?: ToolsFetchOptions;
  batchSize?: number;
  onItem?: (response: ToolsMediaRelationsResponse) => void;
};

/**
 * Fetch relations for many list seeds. Serves cache hits first, then batches
 * the remainder. Each response is stored with all edge types so Franchise
 * and Adaptation can filter client-side.
 */
export async function fetchToolsMediaRelationsBatch(
  mediaIds: readonly number[],
  options: FetchToolsMediaRelationsBatchOptions = {},
): Promise<Map<number, ToolsMediaRelationsResponse>> {
  pruneLegacyToolsRelationCaches();
  const { signal, fetchOptions, onItem } = options;
  const batchSize = options.batchSize ?? 15;
  const out = new Map<number, ToolsMediaRelationsResponse>();
  const pending: number[] = [];

  for (const mediaId of mediaIds) {
    if (fetchOptions?.forceRefresh) {
      pending.push(mediaId);
      continue;
    }
    const cached = await fetchToolsMediaRelationsCached(mediaId, signal, fetchOptions);
    if (cached) {
      out.set(mediaId, cached);
      onItem?.(cached);
    } else {
      pending.push(mediaId);
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
        if (parsed) {
          out.set(mediaId, parsed);
          onItem?.(parsed);
          await persistToolsMediaRelationsCache(mediaId, parsed);
        }
      }
    } catch {
      for (const mediaId of chunk) {
        const parsed = await fetchToolsMediaRelationsLive(mediaId, signal);
        if (parsed) {
          out.set(mediaId, parsed);
          onItem?.(parsed);
          await persistToolsMediaRelationsCache(mediaId, parsed);
        }
      }
    }
  }

  return out;
}
