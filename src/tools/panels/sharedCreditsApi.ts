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
import type { ToolsFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import { withSessionMemo } from '../../lib/importers/anilist/toolsSessionMemo';
import {
  ensureStaffFilmographyFresh,
  ensureUserAnimeListFresh,
  readStaffImagesFromDb,
  readStaffShowMapFromDb,
  readUserListMediaIdsFromDb,
  TOOLS_USER_LIST_STATUSES,
} from '../../lib/importers/anilist/toolsAnilistAccess';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import {
  formatStartDateKey,
  pickMediaTitle,
  type StaffRoleMode,
  type StaffShowMap,
} from './sharedCreditsLogic';

import {
  mediaTitleSource,
  voiceRoleLabelSource,
} from '../toolsDisplayRelabel';

export type ToolStaffNameFields = PersonNameFields & {
  image?: string | null;
};

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
  return withSessionMemo(`tools:staff-search:${name.toLowerCase()}`, async () => {
    const data = await executeAnilistQuery<{
      Staff: StaffSearchHit | StaffSearchHit[] | null;
    }>(TOOLS_STAFF_SEARCH_QUERY, { search: name });
    const match = pickStaffSearchMatch(data?.Staff);
    if (!match?.id) {
      throw new Error(`Could not find staff matching "${name}".`);
    }
    return match.id;
  });
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
  const key = `tools:staff-names:${[...staffIds].sort((a, b) => a - b).join(',')}`;
  return withSessionMemo(
    key,
    async () => {
      let fields = await fetchStaffNameFieldsFromApi(staffIds, signal);
      fields = await enrichStaffNameFieldsImages(fields);
      return fields;
    },
    options,
  );
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
  await ensureStaffFilmographyFresh(staffId, options);
  const ctx = getToolsImportContext();
  const fromDb = await readStaffShowMapFromDb(ctx.db, staffId, roleMode);
  return fromDb ?? (await fetchStaffShowMapLive(staffId, roleMode, signal));
}

export async function fetchUserListMediaIds(
  username: string,
  signal?: AbortSignal,
  options?: ToolsFetchOptions,
): Promise<Set<string>> {
  signal?.throwIfAborted();
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
