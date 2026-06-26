import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_MEDIA_PRODUCTION_STAFF_QUERY,
  TOOLS_MEDIA_RELATIONS_QUERY,
  TOOLS_MEDIA_SEARCH_QUERY,
  TOOLS_MEDIA_STUDIOS_QUERY,
  TOOLS_MEDIA_VOICE_ACTORS_QUERY,
  TOOLS_STAFF_PRODUCTION_FILMOGRAPHY_QUERY,
} from '../../lib/importers/anilist/queries';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import { pickCharacterName, pickPersonName } from '../../lib/importers/anilist/personDisplayLabel';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  withSessionMemo,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import { withPersistentTtlCache } from '../../lib/importers/anilist/toolsPersistentCache';
import {
  ensureMediaCastFresh,
  ensureStaffFilmographyFresh,
  readProductionFilmographyFromDb,
  readShowStaffBundleFromDb,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  mergeRoleIntoMap,
  mergeVaRoleIntoMap,
  tallySingleShowMatches,
  type CreditedEntityMap,
  type ProductionFilmographyShow,
  type SharedStaffCategoryMatches,
  type SharedStaffTopMatch,
  type ShowStaffBundle,
} from './sharedStaffLogic';

export async function searchAnimeShow(
  search: string,
  sortByPopularity: boolean,
  signal?: AbortSignal,
): Promise<{ id: number; title: string }> {
  signal?.throwIfAborted();
  const sort = sortByPopularity ? ['POPULARITY_DESC'] : ['SEARCH_MATCH'];
  const cacheKey = `tools:media-search:${search.toLowerCase()}:${sort.join(',')}`;
  return withSessionMemo(cacheKey, async () => {
    const data = await executeAnilistQuery<{
      Media: {
        id: number;
        title: { english?: string | null; romaji?: string | null };
      } | null;
    }>(TOOLS_MEDIA_SEARCH_QUERY, { search, sort });
    if (!data?.Media?.id) {
      throw new Error(`Could not find show matching "${search}".`);
    }
    return {
      id: data.Media.id,
      title: pickMediaTitle(data.Media.title),
    };
  });
}

async function fetchShowStudiosLive(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  // `executeAnilistQuery` does not yet accept an AbortSignal; the request
  // will still run to completion if the user cancels. Checking at entry
  // at least prevents a stale request from being queued behind an abort.
  signal?.throwIfAborted();
  const data = await executeAnilistQuery<{
    Media: {
      studios: {
        edges: Array<{
          isMain: boolean;
          node: { id: number; name: string };
        }>;
      };
    } | null;
  }>(TOOLS_MEDIA_STUDIOS_QUERY, { mediaId });

  const main: CreditedEntityMap = {};
  const supporting: CreditedEntityMap = {};

  for (const edge of data?.Media?.studios.edges ?? []) {
    const target = edge.isMain ? main : supporting;
    mergeRoleIntoMap(target, edge.node.id, edge.node.name, edge.isMain ? 'Main' : 'Supporting');
  }

  return { ...main, ...supporting };
}

export async function fetchShowStudios(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  await ensureMediaCastFresh(mediaId, options);
  const ctx = getToolsImportContext();
  const bundle = await readShowStaffBundleFromDb(ctx.db, mediaId, '');
  if (bundle && Object.keys(bundle.studios).length > 0) {
    return bundle.studios;
  }
  return fetchShowStudiosLive(mediaId, signal);
}

async function fetchShowProductionStaffLive(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  const edges = await depaginate<
    {
      Media: {
        staff: {
          pageInfo: { hasNextPage: boolean };
          edges: Array<{
            role?: string | null;
            node: { id: number; name: { full: string; native?: string | null } };
          }>;
        };
      } | null;
    },
    { role?: string | null; node: { id: number; name: { full: string; native?: string | null } } }
  >({
    query: TOOLS_MEDIA_PRODUCTION_STAFF_QUERY,
    variables: { mediaId },
    signal,
    selectPage: (data) => ({
      nodes: data.Media?.staff.edges ?? [],
      pageInfo: data.Media?.staff.pageInfo ?? { hasNextPage: false },
    }),
  });

  const map: CreditedEntityMap = {};
  edges.forEach((edge, edgeIndex) => {
    mergeRoleIntoMap(
      map,
      edge.node.id,
      pickPersonName({
        id: edge.node.id,
        name_full: edge.node.name.full,
        name_native: edge.node.name.native ?? null,
      }),
      edge.role ?? '(role unavailable)',
      edgeIndex,
    );
  });
  return map;
}

export async function fetchShowProductionStaff(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  await ensureMediaCastFresh(mediaId, options);
  const ctx = getToolsImportContext();
  const bundle = await readShowStaffBundleFromDb(ctx.db, mediaId, '');
  if (bundle && Object.keys(bundle.productionStaff).length > 0) {
    return bundle.productionStaff;
  }
  return fetchShowProductionStaffLive(mediaId, signal);
}

async function fetchShowVoiceActorsJpLive(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  const edges = await depaginate<
    {
      Media: {
        characters: {
          pageInfo: { hasNextPage: boolean };
          edges: Array<{
            role?: string | null;
            node: { id: number; name: { full: string; native?: string | null } };
            voiceActorRoles: Array<{
              roleNotes?: string | null;
              voiceActor: { id: number; name: { full: string; native?: string | null } };
            }>;
          }>;
        };
      } | null;
    },
    {
      role?: string | null;
      node: { id: number; name: { full: string; native?: string | null } };
      voiceActorRoles: Array<{
        roleNotes?: string | null;
        voiceActor: { id: number; name: { full: string; native?: string | null } };
      }>;
    }
  >({
    query: TOOLS_MEDIA_VOICE_ACTORS_QUERY,
    variables: { mediaId, language: 'JAPANESE' },
    signal,
    selectPage: (data) => ({
      nodes: data.Media?.characters.edges ?? [],
      pageInfo: data.Media?.characters.pageInfo ?? { hasNextPage: false },
    }),
  });

  const map: CreditedEntityMap = {};
  edges.forEach((edge, edgeIndex) => {
    for (const vaRole of edge.voiceActorRoles ?? []) {
      const characterName = pickCharacterName({
        id: edge.node.id,
        name_full: edge.node.name.full,
        name_native: edge.node.name.native ?? null,
      });
      let roleDescr = `${edge.role ?? 'UNKNOWN'} ${characterName}`;
      if (vaRole.roleNotes) {
        roleDescr += ` ${vaRole.roleNotes}`;
      }
      mergeVaRoleIntoMap(
        map,
        vaRole.voiceActor.id,
        pickPersonName({
          id: vaRole.voiceActor.id,
          name_full: vaRole.voiceActor.name.full,
          name_native: vaRole.voiceActor.name.native ?? null,
        }),
        edge.node.id,
        roleDescr,
        edgeIndex,
      );
    }
  });
  return map;
}

export async function fetchShowVoiceActorsJp(
  mediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  await ensureMediaCastFresh(mediaId, options);
  const ctx = getToolsImportContext();
  const bundle = await readShowStaffBundleFromDb(ctx.db, mediaId, '');
  if (bundle && Object.keys(bundle.voiceActors).length > 0) {
    return bundle.voiceActors;
  }
  return fetchShowVoiceActorsJpLive(mediaId, signal);
}

export async function fetchShowStaffBundle(
  mediaId: number,
  title: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<ShowStaffBundle> {
  await ensureMediaCastFresh(mediaId, options);
  const ctx = getToolsImportContext();
  const fromDb = await readShowStaffBundleFromDb(ctx.db, mediaId, title);

  const [studios, productionStaff, voiceActors] = await Promise.all([
    fromDb && Object.keys(fromDb.studios).length > 0
      ? fromDb.studios
      : fetchShowStudios(mediaId, signal, options),
    fromDb && Object.keys(fromDb.productionStaff).length > 0
      ? fromDb.productionStaff
      : fetchShowProductionStaff(mediaId, signal, options),
    fromDb && Object.keys(fromDb.voiceActors).length > 0
      ? fromDb.voiceActors
      : fetchShowVoiceActorsJp(mediaId, signal, options),
  ]);

  return {
    id: mediaId,
    title: fromDb?.title || title,
    coverImage: fromDb?.coverImage ?? null,
    studios,
    productionStaff,
    voiceActors,
  };
}

/**
 * Anime-relation graph rarely changes after release, so the walked set
 * is persisted across sessions for 90 days. Mirrors the Franchise
 * Scores cache. Force-refresh re-walks from scratch (Compare with
 * right-click); without it, the persistent cache is read once per
 * session per root id and then the in-memory session memo serves the
 * Set for the rest of the tab's life.
 */
const RELATED_ANIME_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function relatedAnimeCacheKey(rootMediaId: number): string {
  return `shared-staff:related-anime:${rootMediaId}`;
}

async function walkRelatedAnimeIds(
  rootMediaId: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const related = new Set<number>([rootMediaId]);
  const queue = [rootMediaId];

  while (queue.length > 0) {
    signal?.throwIfAborted();
    const curId = queue.pop()!;
    const data = await executeAnilistQuery<{
      Media: {
        relations: {
          edges: Array<{
            relationType: string;
            node: {
              id: number;
              type: string;
              format?: string | null;
              tags?: Array<{ name: string }> | null;
            };
          }>;
        };
      } | null;
    }>(TOOLS_MEDIA_RELATIONS_QUERY, { mediaId: curId });

    for (const edge of data?.Media?.relations.edges ?? []) {
      const node = edge.node;
      if (node.type !== 'ANIME' || related.has(node.id)) {
        continue;
      }
      related.add(node.id);

      const isCrossover = (node.tags ?? []).some((t) => t.name === 'Crossover');
      if (
        edge.relationType === 'OTHER' ||
        node.format === 'MUSIC' ||
        isCrossover
      ) {
        continue;
      }
      queue.push(node.id);
    }
  }

  related.delete(rootMediaId);
  return [...related];
}

export async function fetchRelatedAnimeIds(
  rootMediaId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<Set<number>> {
  signal?.throwIfAborted();
  const key = relatedAnimeCacheKey(rootMediaId);
  // Two-tier cache: session memo dedups concurrent calls + avoids
  // re-parsing JSON; localStorage layer survives reloads with a 90d
  // TTL. Persisted as a number[] (Sets don't round-trip through JSON)
  // and re-wrapped into a Set at the boundary.
  const ids = await withSessionTtlMemo(
    key,
    RELATED_ANIME_TTL_MS,
    () =>
      withPersistentTtlCache(
        key,
        RELATED_ANIME_TTL_MS,
        () => walkRelatedAnimeIds(rootMediaId, signal),
        { bust: options?.forceRefresh },
      ),
    { bust: options?.forceRefresh },
  );
  return new Set(ids);
}

async function fetchProductionStaffFilmographyLive(
  staffId: number,
  signal?: AbortSignal,
): Promise<ProductionFilmographyShow[]> {
  const edges = await depaginate<
    {
      Staff: {
        staffMedia: {
          pageInfo: { hasNextPage: boolean };
          edges: Array<{
            staffRole?: string | null;
            node: {
              id: number;
              title: { english?: string | null; romaji?: string | null };
            };
          }>;
        };
      } | null;
    },
    {
      staffRole?: string | null;
      node: {
        id: number;
        title: { english?: string | null; romaji?: string | null };
        coverImage?: { large?: string | null } | null;
      };
    }
  >({
    query: TOOLS_STAFF_PRODUCTION_FILMOGRAPHY_QUERY,
    variables: { staffId },
    signal,
    selectPage: (data) => ({
      nodes: data.Staff?.staffMedia.edges ?? [],
      pageInfo: data.Staff?.staffMedia.pageInfo ?? { hasNextPage: false },
    }),
  });

  const byId = new Map<number, ProductionFilmographyShow>();
  for (const edge of edges) {
    const show = edge.node;
    const existing = byId.get(show.id);
    const title = pickMediaTitle(show.title);
    const titleSource = {
      id: show.id,
      title_english: show.title.english ?? null,
      title_romaji: show.title.romaji ?? null,
      title_native: (show.title as { native?: string | null }).native ?? null,
    };
    const coverImage = show.coverImage?.large ?? null;
    const role = edge.staffRole ?? '(role unavailable)';
    if (!existing) {
      byId.set(show.id, {
        id: show.id,
        title,
        roles: [role],
        titleSource,
        coverImage,
      });
    } else {
      existing.roles.push(role);
    }
  }
  return [...byId.values()];
}

export async function fetchProductionStaffFilmography(
  staffId: number,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<ProductionFilmographyShow[]> {
  signal?.throwIfAborted();
  await ensureStaffFilmographyFresh(staffId, options);
  const ctx = getToolsImportContext();
  const fromDb = await readProductionFilmographyFromDb(ctx.db, staffId);
  if (fromDb) {
    return fromDb;
  }
  return fetchProductionStaffFilmographyLive(staffId, signal);
}

export type SharedStaffRunProgress =
  | { phase: 'resolve'; showIndex: number; showTotal: number; label: string }
  | { phase: 'load-show'; label: string }
  | { phase: 'single-scan'; staffIndex: number; staffTotal: number; staffName: string }
  | { phase: 'single-top'; label: string };

export async function runSharedStaffCompare(options: {
  showSearches: string[];
  sortByPopularity: boolean;
  ignoreRelated: boolean;
  topMatchCount: number;
  signal?: AbortSignal;
  onProgress?: (progress: SharedStaffRunProgress) => void;
  fetchOptions?: ToolsFetchOptions;
}): Promise<{
  shows: ShowStaffBundle[];
  singleShowReport?: {
    sourceTitle: string;
    topOverall: SharedStaffTopMatch[];
    byCategory: SharedStaffCategoryMatches[];
  };
  tallyMeta?: {
    topMatchMediaId: number | null;
    titlesById: Record<number, string>;
  };
  singleShowSource?: {
    sourceShowId: number;
    ignoredShowIds: number[];
    topMatchCount: number;
    filmographies: Record<number, ProductionFilmographyShow[]>;
    topMatchMediaId: number | null;
  };
}> {
  const {
    showSearches,
    sortByPopularity,
    ignoreRelated,
    topMatchCount,
    signal,
    onProgress,
    fetchOptions,
  } = options;

  const resolved: Array<{ id: number; title: string }> = [];
  for (let i = 0; i < showSearches.length; i += 1) {
    onProgress?.({
      phase: 'resolve',
      showIndex: i + 1,
      showTotal: showSearches.length,
      label: showSearches[i]!,
    });
    resolved.push(
      await searchAnimeShow(showSearches[i]!, sortByPopularity, signal),
    );
  }

  const shows: ShowStaffBundle[] = [];
  for (const show of resolved) {
    onProgress?.({ phase: 'load-show', label: show.title });
    shows.push(await fetchShowStaffBundle(show.id, show.title, signal, fetchOptions));
  }

  if (shows.length !== 1) {
    return { shows };
  }

  const source = shows[0]!;
  const staffEntries = Object.entries(source.productionStaff);
  if (staffEntries.length === 0) {
    return { shows };
  }

  let ignored = new Set<number>([source.id]);
  if (ignoreRelated) {
    const related = await fetchRelatedAnimeIds(source.id, signal, fetchOptions);
    ignored = new Set([source.id, ...related]);
  }

  const filmographies: Record<number, ProductionFilmographyShow[]> = {};
  for (let i = 0; i < staffEntries.length; i += 1) {
    const [staffKey, staffInfo] = staffEntries[i]!;
    const staffId = Number(staffKey);
    onProgress?.({
      phase: 'single-scan',
      staffIndex: i + 1,
      staffTotal: staffEntries.length,
      staffName: staffInfo.name,
    });
    filmographies[staffId] = await fetchProductionStaffFilmography(staffId, signal, fetchOptions);
  }

  const tally = tallySingleShowMatches({
    sourceShowId: source.id,
    productionStaff: source.productionStaff,
    filmographies,
    ignoredShowIds: ignored,
    topOverall: topMatchCount,
    topCategory: 3,
  });

  const singleShowSource = {
    sourceShowId: source.id,
    ignoredShowIds: [...ignored],
    topMatchCount,
    filmographies,
    topMatchMediaId: tally.topMatchMediaId,
  };

  if (!tally.topMatchMediaId) {
    return { shows, tallyMeta: tally, singleShowSource };
  }

  onProgress?.({
    phase: 'single-top',
    label: tally.titlesById[tally.topMatchMediaId] ?? String(tally.topMatchMediaId),
  });

  const topTitle = tally.titlesById[tally.topMatchMediaId] ?? String(tally.topMatchMediaId);
  const topBundle = await fetchShowStaffBundle(
    tally.topMatchMediaId,
    topTitle,
    signal,
    fetchOptions,
  );
  shows.push(topBundle);

  return {
    shows,
    singleShowReport: {
      sourceTitle: source.title,
      topOverall: tally.topOverall,
      byCategory: tally.byCategory,
    },
    tallyMeta: tally,
    singleShowSource,
  };
}
