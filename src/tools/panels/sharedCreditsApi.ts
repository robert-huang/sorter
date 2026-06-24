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
  pickCharacterName,
  pickPersonName,
  type PersonNameFields,
} from '../../lib/importers/anilist/personDisplayLabel';
import {
  TOOLS_CACHE_TTL_MS,
  toolsCacheDelete,
  toolsCacheGet,
  toolsCacheSet,
  withToolsCache,
} from '../../lib/importers/anilist/toolsCache';
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import {
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  readStaffImagesFromDb,
  readStaffShowMapFromDb,
  readUserListMediaIdsFromDb,
  TOOLS_USER_LIST_STATUSES,
  toolsUserListCacheKey,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  formatStartDateKey,
  pickMediaTitle,
  type StaffRoleEntry,
  type StaffRoleMode,
  type StaffShowEntry,
  type StaffShowMap,
} from './sharedCreditsLogic';

import {
  mediaTitleSource,
  voiceRoleLabelSource,
} from '../toolsDisplayRelabel';

export type ToolStaffNameFields = PersonNameFields & {
  image?: string | null;
};

/** Bump when cached staff-name / role-map shapes change. */
const STAFF_NAMES_CACHE_VERSION = 3;
const STAFF_ROLES_CACHE_VERSION = 2;

/** Legacy caches stored plain name strings instead of PersonNameFields rows. */
export function normalizeStaffNameFieldsFromCache(
  staffIds: number[],
  cached: unknown,
): Record<number, ToolStaffNameFields> | null {
  if (!cached || typeof cached !== 'object') {
    return null;
  }
  const record = cached as Record<string, unknown>;
  const out: Record<number, ToolStaffNameFields> = {};
  for (const staffId of staffIds) {
    const row = record[staffId] ?? record[String(staffId)];
    if (row == null) {
      return null;
    }
    if (typeof row === 'string') {
      out[staffId] = {
        id: staffId,
        name_full: row,
        name_native: null,
        image: null,
      };
      continue;
    }
    if (typeof row !== 'object') {
      return null;
    }
    const fields = row as Partial<ToolStaffNameFields> & {
      name?: { full?: string | null; native?: string | null };
    };
    if (typeof fields.id === 'number') {
      out[staffId] = {
        id: fields.id,
        name_full: fields.name_full ?? null,
        name_native: fields.name_native ?? null,
        image: fields.image ?? null,
      };
      continue;
    }
    if (fields.name?.full) {
      out[staffId] = {
        id: staffId,
        name_full: fields.name.full,
        name_native: fields.name.native ?? null,
        image: fields.image ?? null,
      };
      continue;
    }
    return null;
  }
  return out;
}

/** Legacy role maps stored plain role strings instead of StaffRoleEntry objects. */
export function normalizeStaffShowMapFromCache(cached: unknown): StaffShowMap | null {
  if (!cached || typeof cached !== 'object') {
    return null;
  }
  const record = cached as Record<string, unknown>;
  const out: StaffShowMap = {};
  for (const [mediaId, entry] of Object.entries(record)) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const row = entry as Partial<StaffShowEntry> & { roles?: unknown };
    if (typeof row.title !== 'string') {
      return null;
    }
    const roles: StaffRoleEntry[] = [];
    if (Array.isArray(row.roles)) {
      for (const role of row.roles) {
        if (typeof role === 'string') {
          roles.push({ label: role });
        } else if (
          role &&
          typeof role === 'object' &&
          typeof (role as StaffRoleEntry).label === 'string'
        ) {
          roles.push(role as StaffRoleEntry);
        }
      }
    }
    out[mediaId] = {
      title: row.title,
      coverImage: row.coverImage ?? null,
      roles,
      startDate: row.startDate ?? '99999999',
      titleSource: row.titleSource,
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function staffNamesCacheKey(staffIds: number[]): string {
  return `tools:staff-names:v${STAFF_NAMES_CACHE_VERSION}:${staffIds.join(',')}`;
}

function staffRolesCacheKey(staffId: number, roleMode: StaffRoleMode): string {
  const prefix = roleMode === 'voice' ? 'tools:voice-roles' : 'tools:prod-roles';
  return `${prefix}:v${STAFF_ROLES_CACHE_VERSION}:${staffId}`;
}

const USER_LIST_STATUSES = TOOLS_USER_LIST_STATUSES;

type StaffSearchHit = { id: number; name: { full: string; native?: string | null } };

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
  characters?: Array<{
    id?: number | null;
    name?: { full?: string | null; native?: string | null } | null;
  } | null> | null;
  node: {
    id: number;
    title: { english?: string | null; romaji?: string | null };
    coverImage?: { large?: string | null } | null;
    startDate: { year?: number | null; month?: number | null; day?: number | null };
  };
};

type ProductionEdge = {
  staffRole?: string | null;
  node: {
    id: number;
    title: { english?: string | null; romaji?: string | null };
    coverImage?: { large?: string | null } | null;
    startDate: { year?: number | null; month?: number | null; day?: number | null };
  };
};

function mergeVoiceEdge(map: StaffShowMap, edge: VoiceEdge): void {
  const show = edge.node;
  const mediaId = String(show.id);
  const titleSource = mediaTitleSource({
    id: show.id,
    title_english: show.title.english ?? null,
    title_romaji: show.title.romaji ?? null,
    title_native: (show.title as { native?: string | null }).native ?? null,
  });
  const title = pickMediaTitle(show.title);
  const startDate = formatStartDateKey(show.startDate);
  const characterRole = edge.characterRole ?? 'UNKNOWN';
  const characters = (edge.characters ?? [])
    .map((c) => {
      if (!c?.name?.full && !c?.name?.native) {
        return null;
      }
      const characterId = c.id ?? 0;
      const characterNameFull = c.name?.full ?? null;
      const characterNameNative = c.name?.native ?? null;
      const characterName = pickCharacterName(
        {
          id: characterId,
          name_full: characterNameFull,
          name_native: characterNameNative,
        },
        undefined,
        'Character',
      );
      return { characterId, characterName, characterNameFull, characterNameNative };
    })
    .filter(
      (
        entry,
      ): entry is {
        characterId: number;
        characterName: string;
        characterNameFull: string | null;
        characterNameNative: string | null;
      } => Boolean(entry),
    );

  const coverImage = show.coverImage?.large ?? null;

  if (!map[mediaId]) {
    map[mediaId] = { title, roles: [], startDate, coverImage, titleSource };
  } else if (!map[mediaId].coverImage && coverImage) {
    map[mediaId].coverImage = coverImage;
  } else if (!map[mediaId].titleSource) {
    map[mediaId].titleSource = titleSource;
  }

  for (const {
    characterId,
    characterName,
    characterNameFull,
    characterNameNative,
  } of characters) {
    const labelSource = voiceRoleLabelSource({
      characterId,
      characterNameFull,
      characterNameNative,
      characterRole,
    });
    map[mediaId].roles.push({
      label: `${characterName} (${characterRole})`,
      characterId: characterId > 0 ? characterId : undefined,
      labelSource,
    });
  }
}

function mergeProductionEdge(map: StaffShowMap, edge: ProductionEdge): void {
  const show = edge.node;
  const mediaId = String(show.id);
  const titleSource = mediaTitleSource({
    id: show.id,
    title_english: show.title.english ?? null,
    title_romaji: show.title.romaji ?? null,
    title_native: (show.title as { native?: string | null }).native ?? null,
  });
  const title = pickMediaTitle(show.title);
  const startDate = formatStartDateKey(show.startDate);
  const staffRole = edge.staffRole ?? '(role unavailable)';

  const coverImage = show.coverImage?.large ?? null;

  if (!map[mediaId]) {
    map[mediaId] = { title, roles: [], startDate, coverImage, titleSource };
  } else if (!map[mediaId].coverImage && coverImage) {
    map[mediaId].coverImage = coverImage;
  } else if (!map[mediaId].titleSource) {
    map[mediaId].titleSource = titleSource;
  }

  map[mediaId].roles.push({
    label: staffRole,
    labelSource: { kind: 'production', staffRole },
  });
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

async function enrichStaffNameFieldsImages(
  fields: Record<number, ToolStaffNameFields>,
): Promise<Record<number, ToolStaffNameFields>> {
  const ctx = getToolsImportContext();
  const images = await readStaffImagesFromDb(ctx.db, Object.keys(fields).map(Number));
  const out: Record<number, ToolStaffNameFields> = { ...fields };
  for (const [id, image] of Object.entries(images)) {
    const staffId = Number(id);
    const row = out[staffId];
    if (!row || !image || row.image) {
      continue;
    }
    out[staffId] = { ...row, image };
  }
  return out;
}

async function fetchStaffNameFieldsFromApi(
  staffIds: number[],
  signal?: AbortSignal,
): Promise<Record<number, ToolStaffNameFields>> {
  const staff = await depaginate<
    {
      Page: {
        pageInfo: { hasNextPage: boolean };
        staff: Array<{
          id: number;
          name: { full: string; native?: string | null };
          image?: { large?: string | null } | null;
        }>;
      } | null;
    },
    {
      id: number;
      name: { full: string; native?: string | null };
      image?: { large?: string | null } | null;
    }
  >({
    query: TOOLS_STAFF_BY_IDS_QUERY,
    variables: { staffIds },
    signal,
    selectPage: (data) => ({
      nodes: data.Page?.staff ?? [],
      pageInfo: data.Page?.pageInfo ?? { hasNextPage: false },
    }),
  });

  const fields: Record<number, ToolStaffNameFields> = {};
  for (const row of staff) {
    fields[row.id] = {
      id: row.id,
      name_full: row.name.full,
      name_native: row.name.native ?? null,
      image: row.image?.large ?? null,
    };
  }
  if (Object.keys(fields).length !== staffIds.length) {
    throw new Error('Could not fetch names for all staff ids.');
  }
  return fields;
}

export async function fetchStaffNameFieldsByIds(
  staffIds: number[],
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<Record<number, ToolStaffNameFields>> {
  signal?.throwIfAborted();
  const key = staffNamesCacheKey(staffIds);
  if (options?.forceRefresh) {
    await toolsCacheDelete(key);
  } else {
    const cached = await toolsCacheGet<unknown>(key);
    const normalized = cached ? normalizeStaffNameFieldsFromCache(staffIds, cached) : null;
    if (normalized) {
      const enriched = await enrichStaffNameFieldsImages(normalized);
      if (!staffIds.some((id) => !enriched[id]?.image)) {
        return enriched;
      }
    } else if (cached != null) {
      await toolsCacheDelete(key);
    }
  }

  let fields = await fetchStaffNameFieldsFromApi(staffIds, signal);
  fields = await enrichStaffNameFieldsImages(fields);
  await toolsCacheSet(key, fields, TOOLS_CACHE_TTL_MS.staffSearch);
  return fields;
}

export async function fetchStaffNamesByIds(
  staffIds: number[],
  signal?: AbortSignal,
): Promise<Record<number, string>> {
  const fields = await fetchStaffNameFieldsByIds(staffIds, signal);
  const names: Record<number, string> = {};
  for (const [id, row] of Object.entries(fields)) {
    names[Number(id)] = pickPersonName(row);
  }
  return names;
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
  const cacheKey = staffRolesCacheKey(staffId, roleMode);
  const ttl = TOOLS_CACHE_TTL_MS.staffRoles;

  if (!options?.forceRefresh) {
    const cached = await toolsCacheGet<unknown>(cacheKey);
    const normalized = cached ? normalizeStaffShowMapFromCache(cached) : null;
    if (normalized) {
      return normalized;
    }
    if (cached != null) {
      await toolsCacheDelete(cacheKey);
    }
  } else {
    await toolsCacheDelete(cacheKey);
  }

  await ensureStaffFilmographyFresh(staffId, options);
  const ctx = getToolsImportContext();
  const fromDb = await readStaffShowMapFromDb(ctx.db, staffId, roleMode);
  const value = fromDb ?? (await fetchStaffShowMapLive(staffId, roleMode, signal));
  await toolsCacheSet(cacheKey, value, ttl);
  return value;
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
  staffNameFields: Record<number, ToolStaffNameFields>;
  lists: StaffShowMap[];
  userMediaIds: Set<string> | null;
  usernameMode: 'include' | 'exclude' | null;
}> {
  const { staffIds, roleMode, usernameInclude, usernameExclude, signal, onProgress, fetchOptions } =
    options;

  onProgress?.({ phase: 'names' });
  const staffNameFields = await fetchStaffNameFieldsByIds(staffIds, signal, fetchOptions);
  const staffNames = Object.fromEntries(
    Object.entries(staffNameFields).map(([id, row]) => [Number(id), pickPersonName(row)]),
  ) as Record<number, string>;

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

  // Prefer DB-backed maps (label sources + complete cast) over any legacy cache rows.
  const ctx = getToolsImportContext();
  for (let i = 0; i < staffIds.length; i += 1) {
    const fromDb = await readStaffShowMapFromDb(ctx.db, staffIds[i]!, roleMode);
    if (fromDb) {
      lists[i] = fromDb;
    }
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
  return { staffNameFields, lists, userMediaIds, usernameMode };
}
