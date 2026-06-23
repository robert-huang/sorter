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
import { TOOLS_CACHE_TTL_MS, withToolsCache } from '../../lib/importers/anilist/toolsCache';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  mergeRoleIntoMap,
  tallySingleShowMatches,
  type CreditedEntityMap,
  type ProductionFilmographyShow,
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
  return withToolsCache(cacheKey, TOOLS_CACHE_TTL_MS.showMetadata, async () => {
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

export async function fetchShowStudios(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:show-studios:${mediaId}`,
    TOOLS_CACHE_TTL_MS.showMetadata,
    async () => {
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
    },
  );
}

export async function fetchShowProductionStaff(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:show-prod-staff:${mediaId}`,
    TOOLS_CACHE_TTL_MS.showMetadata,
    async () => {
      const edges = await depaginate<
        {
          Media: {
            staff: {
              pageInfo: { hasNextPage: boolean };
              edges: Array<{
                role?: string | null;
                node: { id: number; name: { full: string } };
              }>;
            };
          } | null;
        },
        { role?: string | null; node: { id: number; name: { full: string } } }
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
      for (const edge of edges) {
        mergeRoleIntoMap(
          map,
          edge.node.id,
          edge.node.name.full,
          edge.role ?? '(role unavailable)',
        );
      }
      return map;
    },
  );
}

export async function fetchShowVoiceActorsJp(
  mediaId: number,
  signal?: AbortSignal,
): Promise<CreditedEntityMap> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:show-vas-jp:${mediaId}`,
    TOOLS_CACHE_TTL_MS.showMetadata,
    async () => {
      const edges = await depaginate<
        {
          Media: {
            characters: {
              pageInfo: { hasNextPage: boolean };
              edges: Array<{
                role?: string | null;
                node: { name: { full: string } };
                voiceActorRoles: Array<{
                  roleNotes?: string | null;
                  voiceActor: { id: number; name: { full: string } };
                }>;
              }>;
            };
          } | null;
        },
        {
          role?: string | null;
          node: { name: { full: string } };
          voiceActorRoles: Array<{
            roleNotes?: string | null;
            voiceActor: { id: number; name: { full: string } };
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
      for (const edge of edges) {
        for (const vaRole of edge.voiceActorRoles ?? []) {
          let roleDescr = `${edge.role ?? 'UNKNOWN'} ${edge.node.name.full}`;
          if (vaRole.roleNotes) {
            roleDescr += ` ${vaRole.roleNotes}`;
          }
          mergeRoleIntoMap(
            map,
            vaRole.voiceActor.id,
            vaRole.voiceActor.name.full,
            roleDescr,
          );
        }
      }
      return map;
    },
  );
}

export async function fetchShowStaffBundle(
  mediaId: number,
  title: string,
  signal?: AbortSignal,
): Promise<ShowStaffBundle> {
  const [studios, productionStaff, voiceActors] = await Promise.all([
    fetchShowStudios(mediaId, signal),
    fetchShowProductionStaff(mediaId, signal),
    fetchShowVoiceActorsJp(mediaId, signal),
  ]);
  return { id: mediaId, title, studios, productionStaff, voiceActors };
}

export async function fetchRelatedAnimeIds(
  rootMediaId: number,
  signal?: AbortSignal,
): Promise<Set<number>> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:related-anime:${rootMediaId}`,
    TOOLS_CACHE_TTL_MS.showMetadata,
    async () => {
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
      return related;
    },
  );
}

export async function fetchProductionStaffFilmography(
  staffId: number,
  signal?: AbortSignal,
): Promise<ProductionFilmographyShow[]> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:prod-filmography:${staffId}`,
    TOOLS_CACHE_TTL_MS.staffRoles,
    async () => {
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
        const role = edge.staffRole ?? '(role unavailable)';
        if (!existing) {
          byId.set(show.id, { id: show.id, title, roles: [role] });
        } else {
          existing.roles.push(role);
        }
      }
      return [...byId.values()];
    },
  );
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
}): Promise<{
  shows: ShowStaffBundle[];
  singleShowReport?: {
    sourceTitle: string;
    topOverall: Array<{ mediaId: number; title: string; sharedStaffCount: number }>;
    byCategory: Array<{
      label: string;
      matches: Array<{ mediaId: number; title: string; sharedStaffCount: number }>;
    }>;
  };
  tallyMeta?: {
    topMatchMediaId: number | null;
    titlesById: Record<number, string>;
  };
}> {
  const {
    showSearches,
    sortByPopularity,
    ignoreRelated,
    topMatchCount,
    signal,
    onProgress,
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
    shows.push(await fetchShowStaffBundle(show.id, show.title, signal));
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
    const related = await fetchRelatedAnimeIds(source.id, signal);
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
    filmographies[staffId] = await fetchProductionStaffFilmography(staffId, signal);
  }

  const tally = tallySingleShowMatches({
    sourceShowId: source.id,
    productionStaff: source.productionStaff,
    filmographies,
    ignoredShowIds: ignored,
    topOverall: topMatchCount,
    topCategory: 3,
  });

  if (!tally.topMatchMediaId) {
    return { shows, tallyMeta: tally };
  }

  onProgress?.({
    phase: 'single-top',
    label: tally.titlesById[tally.topMatchMediaId] ?? String(tally.topMatchMediaId),
  });

  const topTitle = tally.titlesById[tally.topMatchMediaId] ?? String(tally.topMatchMediaId);
  const topBundle = await fetchShowStaffBundle(tally.topMatchMediaId, topTitle, signal);
  shows.push(topBundle);

  return {
    shows,
    singleShowReport: {
      sourceTitle: source.title,
      topOverall: tally.topOverall,
      byCategory: tally.byCategory,
    },
    tallyMeta: tally,
  };
}
