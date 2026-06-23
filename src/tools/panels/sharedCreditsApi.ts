import { depaginate } from '../../lib/importers/anilist/depaginate';
import {
  TOOLS_STAFF_BY_IDS_QUERY,
  TOOLS_STAFF_PRODUCTION_ROLES_QUERY,
  TOOLS_STAFF_SEARCH_QUERY,
  TOOLS_STAFF_VOICE_ROLES_QUERY,
  TOOLS_USER_ANIME_LIST_QUERY,
} from '../../lib/importers/anilist/queries';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import {
  TOOLS_CACHE_TTL_MS,
  withToolsCache,
} from '../../lib/importers/anilist/toolsCache';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  readStaffShowMapFromDb,
  readUserListMediaIdsFromDb,
  TOOLS_USER_LIST_STATUSES,
  toolsUserListCacheKey,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  formatStartDateKey,
  pickMediaTitle,
  type StaffRoleMode,
  type StaffShowMap,
} from './sharedCreditsLogic';

const USER_LIST_STATUSES = TOOLS_USER_LIST_STATUSES;

type StaffSearchHit = { id: number; name: { full: string } };

/** Root `Staff(search:)` returns one row; `Page.staff` returns a list. */
export function pickStaffSearchMatch(
  staff: StaffSearchHit | StaffSearchHit[] | null | undefined,
): StaffSearchHit | null {
  if (!staff) {
    return null;
  }
  return Array.isArray(staff) ? (staff[0] ?? null) : staff;
}

type VoiceEdge = {
  characterRole?: string | null;
  characters?: Array<{ name?: { full?: string | null } | null } | null> | null;
  node: {
    id: number;
    title: { english?: string | null; romaji?: string | null };
    startDate: { year?: number | null; month?: number | null; day?: number | null };
  };
};

type ProductionEdge = {
  staffRole?: string | null;
  node: {
    id: number;
    title: { english?: string | null; romaji?: string | null };
    startDate: { year?: number | null; month?: number | null; day?: number | null };
  };
};

function mergeVoiceEdge(map: StaffShowMap, edge: VoiceEdge): void {
  const show = edge.node;
  const mediaId = String(show.id);
  const title = pickMediaTitle(show.title);
  const startDate = formatStartDateKey(show.startDate);
  const characterRole = edge.characterRole ?? 'UNKNOWN';
  const characters = (edge.characters ?? [])
    .map((c) => c?.name?.full)
    .filter((name): name is string => Boolean(name));

  if (!map[mediaId]) {
    map[mediaId] = { title, roles: [], startDate };
  }

  for (const character of characters) {
    map[mediaId].roles.push(`${character} (${characterRole})`);
  }
}

function mergeProductionEdge(map: StaffShowMap, edge: ProductionEdge): void {
  const show = edge.node;
  const mediaId = String(show.id);
  const title = pickMediaTitle(show.title);
  const startDate = formatStartDateKey(show.startDate);

  if (!map[mediaId]) {
    map[mediaId] = { title, roles: [], startDate };
  }

  map[mediaId].roles.push(edge.staffRole ?? '(role unavailable)');
}

export async function resolveStaffIdByName(
  name: string,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  return withToolsCache(
    `tools:staff-search:${name.toLowerCase()}`,
    TOOLS_CACHE_TTL_MS.staffSearch,
    async () => {
      const data = await executeAnilistQuery<{
        Staff: StaffSearchHit | StaffSearchHit[] | null;
      }>(TOOLS_STAFF_SEARCH_QUERY, { search: name });
      const match = pickStaffSearchMatch(data?.Staff);
      if (!match?.id) {
        throw new Error(`Could not find staff matching "${name}".`);
      }
      return match.id;
    },
  );
}

export async function resolveStaffIds(
  inputs: string[],
  useIds: boolean,
  signal?: AbortSignal,
): Promise<number[]> {
  const ids: number[] = [];
  for (const raw of inputs) {
    signal?.throwIfAborted();
    if (useIds) {
      const id = Number.parseInt(raw, 10);
      if (!Number.isFinite(id)) {
        throw new Error(`Invalid staff id "${raw}".`);
      }
      ids.push(id);
    } else {
      ids.push(await resolveStaffIdByName(raw, signal));
    }
  }
  return ids;
}

export async function fetchStaffNamesByIds(
  staffIds: number[],
  signal?: AbortSignal,
): Promise<Record<number, string>> {
  signal?.throwIfAborted();
  const key = `tools:staff-names:${staffIds.join(',')}`;
  return withToolsCache(key, TOOLS_CACHE_TTL_MS.staffSearch, async () => {
    const staff = await depaginate<
      {
        Page: {
          pageInfo: { hasNextPage: boolean };
          staff: Array<{ id: number; name: { full: string } }>;
        } | null;
      },
      { id: number; name: { full: string } }
    >({
      query: TOOLS_STAFF_BY_IDS_QUERY,
      variables: { staffIds },
      signal,
      selectPage: (data) => ({
        nodes: data.Page?.staff ?? [],
        pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
      }),
    });

    const names: Record<number, string> = {};
    for (const row of staff) {
      names[row.id] = row.name.full;
    }
    if (Object.keys(names).length !== staffIds.length) {
      throw new Error('Could not fetch names for all staff ids.');
    }
    return names;
  });
}

async function fetchStaffShowMapLive(
  staffId: number,
  roleMode: StaffRoleMode,
  signal?: AbortSignal,
): Promise<StaffShowMap> {
  if (roleMode === 'voice') {
    const edges = await depaginate<
      {
        Staff: {
          characterMedia: {
            pageInfo: { hasNextPage: boolean };
            edges: VoiceEdge[];
          };
        } | null;
      },
      VoiceEdge
    >({
      query: TOOLS_STAFF_VOICE_ROLES_QUERY,
      variables: { id: staffId },
      signal,
      selectPage: (data) => ({
        nodes: data.Staff?.characterMedia.edges ?? [],
        pageInfo: data.Staff?.characterMedia.pageInfo ?? { hasNextPage: false },
      }),
    });

    const map: StaffShowMap = {};
    for (const edge of edges) {
      mergeVoiceEdge(map, edge);
    }
    return map;
  }

  const edges = await depaginate<
    {
      Staff: {
        staffMedia: {
          pageInfo: { hasNextPage: boolean };
          edges: ProductionEdge[];
        };
      } | null;
    },
    ProductionEdge
  >({
    query: TOOLS_STAFF_PRODUCTION_ROLES_QUERY,
    variables: { id: staffId },
    signal,
    selectPage: (data) => ({
      nodes: data.Staff?.staffMedia.edges ?? [],
      pageInfo: data.Staff?.staffMedia.pageInfo ?? { hasNextPage: false },
    }),
  });

  const map: StaffShowMap = {};
  for (const edge of edges) {
    mergeProductionEdge(map, edge);
  }
  return map;
}

export async function fetchStaffShowMap(
  staffId: number,
  roleMode: StaffRoleMode,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<StaffShowMap> {
  signal?.throwIfAborted();
  const cacheKey =
    roleMode === 'voice'
      ? `tools:voice-roles:${staffId}`
      : `tools:prod-roles:${staffId}`;
  const ttl = TOOLS_CACHE_TTL_MS.staffRoles;

  return withToolsCache(
    cacheKey,
    ttl,
    async () => {
      await ensureStaffFilmographyFresh(staffId, options);
      const ctx = getToolsImportContext();
      const fromDb = await readStaffShowMapFromDb(ctx.db, staffId, roleMode);
      if (fromDb) {
        return fromDb;
      }
      return fetchStaffShowMapLive(staffId, roleMode, signal);
    },
    options,
  );
}

export async function fetchUserListMediaIds(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<Set<string>> {
  signal?.throwIfAborted();
  const key = toolsUserListCacheKey(username);
  return withToolsCache(
    key,
    TOOLS_CACHE_TTL_MS.userList,
    async () => {
      const user = await ensureUserAnimeListFresh(username, options);
      if (user) {
        const ctx = getToolsImportContext();
        const fromDb = await readUserListMediaIdsFromDb(
          ctx.db,
          user.id,
          USER_LIST_STATUSES,
        );
        if (fromDb.size > 0) {
          return fromDb;
        }
      }

      const entries = await depaginate<
        {
          Page: {
            pageInfo: { hasNextPage: boolean };
            mediaList: Array<{ mediaId: number }>;
          } | null;
        },
        { mediaId: number }
      >({
        query: TOOLS_USER_ANIME_LIST_QUERY,
        variables: { userName: username, statusIn: [...USER_LIST_STATUSES] },
        signal,
        selectPage: (data) => ({
          nodes: data.Page?.mediaList ?? [],
          pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
        }),
      });
      return new Set(entries.map((e) => String(e.mediaId)));
    },
    options,
  );
}

export type SharedCreditsRunProgress =
  | { phase: 'resolve' }
  | { phase: 'names' }
  | { phase: 'roles'; staffIndex: number; staffTotal: number; staffName: string }
  | { phase: 'user-list' }
  | { phase: 'compare' };

export async function runSharedCreditsCompare(options: {
  staffIds: number[];
  roleMode: StaffRoleMode;
  usernameInclude: string;
  usernameExclude: string;
  signal?: AbortSignal;
  onProgress?: (progress: SharedCreditsRunProgress) => void;
  fetchOptions?: ToolsFetchOptions;
}): Promise<{
  staffNames: Record<number, string>;
  lists: StaffShowMap[];
  userMediaIds: Set<string> | null;
  usernameMode: 'include' | 'exclude' | null;
}> {
  const { staffIds, roleMode, usernameInclude, usernameExclude, signal, onProgress, fetchOptions } =
    options;

  onProgress?.({ phase: 'names' });
  const staffNames = await fetchStaffNamesByIds(staffIds, signal);

  const lists: StaffShowMap[] = [];
  for (let i = 0; i < staffIds.length; i += 1) {
    const staffId = staffIds[i]!;
    onProgress?.({
      phase: 'roles',
      staffIndex: i + 1,
      staffTotal: staffIds.length,
      staffName: staffNames[staffId] ?? String(staffId),
    });
    lists.push(await fetchStaffShowMap(staffId, roleMode, signal, fetchOptions));
  }

  let userMediaIds: Set<string> | null = null;
  let usernameMode: 'include' | 'exclude' | null = null;
  const includeUser = usernameInclude.trim();
  const excludeUser = usernameExclude.trim();
  if (includeUser) {
    onProgress?.({ phase: 'user-list' });
    userMediaIds = await fetchUserListMediaIds(includeUser, signal, fetchOptions);
    usernameMode = 'include';
  } else if (excludeUser) {
    onProgress?.({ phase: 'user-list' });
    userMediaIds = await fetchUserListMediaIds(excludeUser, signal, fetchOptions);
    usernameMode = 'exclude';
  }

  onProgress?.({ phase: 'compare' });
  return { staffNames, lists, userMediaIds, usernameMode };
}
