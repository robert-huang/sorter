import {
  alignRoleCellsAcrossShows,
  alignVaRoleCellsAcrossShows,
  dictIntersection,
  type VaRoleCell,
} from '../../lib/importers/anilist/toolsDictUtils';
import { parseLinesOnePerLine } from '../parseToolLines';
import {
  anyTrimmedRoleInSet,
  MUSIC_ROLES,
  VISUALS_ROLES,
  WRITING_ROLES,
} from '../../lib/importers/anilist/staffRoleBuckets';
import {
  isKeyProductionRole,
  normalizeProductionRoleForCompare,
  sortProductionRoleRowsByRank,
} from '../../lib/importers/anilist/staffRoleFilter';

export type CreditedEntity = {
  name: string;
  roles: string[];
  image?: string | null;
  /** Parallel to `roles` for JP VA credits — used to align rows by character id. */
  roleCharacterIds?: number[];
  /** First-seen API edge index (character or staff) for relevance ordering. */
  relevanceOrder?: number;
};

/** id string → entity with accumulated roles. */
export type CreditedEntityMap = Record<string, CreditedEntity>;

export type ShowStaffBundle = {
  id: number;
  title: string;
  coverImage?: string | null;
  studios: CreditedEntityMap;
  productionStaff: CreditedEntityMap;
  voiceActors: CreditedEntityMap;
};

export type SharedStaffForm = {
  showText: string;
  sortByPopularity: boolean;
  ignoreRelated: boolean;
  /**
   * When true, the compare chart includes every studio/staff/VA from every
   * show (union) and leaves the cell blank where a show lacks that entity.
   * When false (default), only entities that appear in EVERY show are listed
   * (intersection).
   */
  includeAll: boolean;
  /** Slow filmography scan — only when enabled and exactly one show is entered. */
  enableSingleShowMode: boolean;
  topMatchCount: number;
};

export type SharedStaffSectionRow = {
  entityId: number;
  name: string;
  imageUrl?: string | null;
  kind: 'studio' | 'staff' | 'va';
  cells: string[];
};

export type SharedStaffSection = {
  title: string;
  rows: SharedStaffSectionRow[];
};

export type SharedStaffTopMatch = {
  mediaId: number;
  title: string;
  coverImage: string | null;
  sharedStaffCount: number;
};

export type SharedStaffCategoryMatches = {
  label: string;
  matches: SharedStaffTopMatch[];
};

export type SharedStaffResult =
  | { kind: 'empty'; message: string }
  | {
      kind: 'compare';
      shows: Array<{ id: number; title: string; coverImage: string | null }>;
      sections: SharedStaffSection[];
      singleShowReport?: {
        sourceTitle: string;
        topOverall: SharedStaffTopMatch[];
        byCategory: SharedStaffCategoryMatches[];
      };
    };

const SECTIONS = [
  { key: 'studios' as const, title: 'Studios' },
  { key: 'productionStaff' as const, title: 'Production Staff' },
  { key: 'voiceActors' as const, title: 'Voice Actors (JP)' },
];

export function parseShowInputs(text: string): string[] {
  return parseLinesOnePerLine(text);
}

export function normalizeStaffName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

export function mergeRoleIntoMap(
  map: CreditedEntityMap,
  id: number,
  name: string,
  role: string,
  relevanceOrder?: number,
  image?: string | null,
): void {
  const key = String(id);
  if (!map[key]) {
    map[key] = {
      name: normalizeStaffName(name),
      roles: [],
      relevanceOrder,
      image: image ?? null,
    };
  } else if (image && !map[key].image) {
    map[key].image = image;
  }
  map[key].roles.push(role);
}

function splitVaRoleLabel(label: string): { castRole: string; characterName: string } {
  const space = label.indexOf(' ');
  if (space < 0) {
    return { castRole: label, characterName: '' };
  }
  return { castRole: label.slice(0, space), characterName: label.slice(space + 1) };
}

const VA_CAST_TIERS = ['MAIN', 'SUPPORTING', 'BACKGROUND'] as const;
type VaCastTier = (typeof VA_CAST_TIERS)[number];

/** Lower index = more prominent cast billing (MAIN first). */
function vaRoleCastTierIndex(roleLabel: string): number {
  const { castRole } = splitVaRoleLabel(roleLabel);
  let best = Number.MAX_SAFE_INTEGER;
  for (const token of castRole.split('/')) {
    const tierIdx = VA_CAST_TIERS.indexOf(token as VaCastTier);
    if (tierIdx >= 0) {
      best = Math.min(best, tierIdx);
    }
  }
  return best;
}

function vaEntityHasCastTier(
  entity: CreditedEntity | undefined,
  tier: VaCastTier,
): boolean {
  if (!entity) {
    return false;
  }
  const tierIdx = VA_CAST_TIERS.indexOf(tier);
  return entity.roles.some((role) => vaRoleCastTierIndex(role) === tierIdx);
}

function compareVaRelevanceInMap(map: CreditedEntityMap, idA: string, idB: string): number {
  const orderA = map[idA]?.relevanceOrder ?? Number.MAX_SAFE_INTEGER;
  const orderB = map[idB]?.relevanceOrder ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return Number(idA) - Number(idB);
}

function sortVaRolesForAlignment(roles: readonly VaRoleCell[]): VaRoleCell[] {
  return roles
    .map((role, originalIdx) => ({
      role,
      originalIdx,
      tier: vaRoleCastTierIndex(role.label),
    }))
    .sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier - b.tier;
      }
      return a.originalIdx - b.originalIdx;
    })
    .map((entry) => entry.role);
}

function bestCastTierIndexForVaRow(cells: readonly string[]): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const cell of cells) {
    if (!cell) {
      continue;
    }
    best = Math.min(best, vaRoleCastTierIndex(cell));
  }
  return best;
}

/** MAIN → SUPPORTING → BACKGROUND within each VA's aligned character rows. */
export function sortVaRoleRowsByCastTier(
  rows: ReadonlyArray<readonly string[]>,
): string[][] {
  const withMeta = rows.map((cells, originalIdx) => ({
    cells: [...cells],
    originalIdx,
    tier: bestCastTierIndexForVaRow(cells),
  }));
  withMeta.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    return a.originalIdx - b.originalIdx;
  });
  return withMeta.map((entry) => entry.cells);
}

function mergeVaRoleLabels(existing: string, incoming: string): string {
  if (existing === incoming) {
    return existing;
  }
  const left = splitVaRoleLabel(existing);
  const right = splitVaRoleLabel(incoming);
  if (
    left.characterName &&
    left.characterName === right.characterName &&
    left.castRole !== right.castRole
  ) {
    return `${left.castRole}/${right.castRole} ${left.characterName}`;
  }
  return `${existing}; ${incoming}`;
}

/** Accumulate JP VA credits keyed by staff id; same character id shares one role slot. */
export function mergeVaRoleIntoMap(
  map: CreditedEntityMap,
  vaId: number,
  vaName: string,
  characterId: number,
  roleLabel: string,
  relevanceOrder?: number,
  image?: string | null,
): void {
  const key = String(vaId);
  if (!map[key]) {
    map[key] = {
      name: normalizeStaffName(vaName),
      roles: [],
      roleCharacterIds: [],
      relevanceOrder,
      image: image ?? null,
    };
  } else if (image && !map[key].image) {
    map[key].image = image;
  }
  const entity = map[key]!;
  const characterIds = entity.roleCharacterIds ?? (entity.roleCharacterIds = []);
  const existingIdx = characterIds.indexOf(characterId);
  if (existingIdx >= 0) {
    entity.roles[existingIdx] = mergeVaRoleLabels(entity.roles[existingIdx]!, roleLabel);
    return;
  }
  characterIds.push(characterId);
  entity.roles.push(roleLabel);
  if (relevanceOrder !== undefined && entity.relevanceOrder === undefined) {
    entity.relevanceOrder = relevanceOrder;
  }
}


function formatStudioRoleCell(roles: readonly string[]): string {
  return roles.join(', ');
}

function studioHasRole(entity: CreditedEntity | undefined, role: 'Main' | 'Supporting'): boolean {
  return entity?.roles.includes(role) ?? false;
}

/**
 * Studio compare rows: mains for show 1, then show 2, … then supporting
 * studios for show 1, show 2, … (left-to-right / top-to-down in the grid).
 */
export function orderStudioEntityIds(
  maps: CreditedEntityMap[],
  threshold: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const qualifies = (id: string): boolean => {
    const count = maps.reduce((acc, map) => acc + (id in map ? 1 : 0), 0);
    return count >= threshold;
  };

  const add = (id: string) => {
    if (!seen.has(id) && qualifies(id)) {
      seen.add(id);
      out.push(id);
    }
  };

  for (const map of maps) {
    for (const id of Object.keys(map)) {
      if (studioHasRole(map[id], 'Main')) {
        add(id);
      }
    }
  }

  for (const map of maps) {
    for (const id of Object.keys(map)) {
      if (studioHasRole(map[id], 'Supporting')) {
        add(id);
      }
    }
  }

  return out;
}

/**
 * VA compare rows: MAIN credits for show 1, show 2, … then SUPPORTING per
 * show, then BACKGROUND — left-to-right / top-to-down. Within each show and
 * tier, API relevance order is preserved.
 */
export function orderVaEntityIds(
  maps: CreditedEntityMap[],
  threshold: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const qualifies = (id: string): boolean => {
    const count = maps.reduce((acc, map) => acc + (id in map ? 1 : 0), 0);
    return count >= threshold;
  };

  const add = (id: string) => {
    if (!seen.has(id) && qualifies(id)) {
      seen.add(id);
      out.push(id);
    }
  };

  for (const tier of VA_CAST_TIERS) {
    for (const map of maps) {
      const ids = Object.keys(map)
        .filter((id) => vaEntityHasCastTier(map[id], tier))
        .sort((a, b) => compareVaRelevanceInMap(map, a, b));
      for (const id of ids) {
        add(id);
      }
    }
  }

  for (const map of maps) {
    const ids = Object.keys(map).sort((a, b) => compareVaRelevanceInMap(map, a, b));
    for (const id of ids) {
      add(id);
    }
  }

  return out;
}

function entityRowsForCompare(
  maps: CreditedEntityMap[],
  id: string,
  kind: 'studio' | 'staff' | 'va',
): SharedStaffSectionRow[] {
  const roleLists = maps.map((m) => m[id]?.roles ?? []);
  const aligned =
    kind === 'va'
      ? (() => {
          const rows = alignVaRoleCellsAcrossShows(
            maps.map((m) => {
              const entity = m[id];
              if (!entity) {
                return [];
              }
              const characterIds = entity.roleCharacterIds ?? [];
              return sortVaRolesForAlignment(
                entity.roles.map((label, roleIdx) => ({
                  characterId: characterIds[roleIdx] ?? -(roleIdx + 1),
                  label,
                })),
              );
            }),
          );
          return sortVaRoleRowsByCastTier(rows);
        })()
        : kind === 'studio'
        ? [maps.map((m) => formatStudioRoleCell(m[id]?.roles ?? []))]
        : (() => {
          // Production staff: collapse "(...)" scope when aligning so e.g.
          // `Animation Director (OP1)` shares a row with `Animation Director
          // (eps 1-4)`, but Chief Animation Director stays on its own row.
          const aligned = alignRoleCellsAcrossShows(
            roleLists,
            normalizeProductionRoleForCompare,
          );
          return sortProductionRoleRowsByRank(aligned);
        })();
  // Find name/image from any map that has this entity — required for
  // "include all" mode where the entity may be absent from maps[0].
  const firstHit = maps.find((m) => m[id]);
  const displayName = normalizeStaffName(firstHit?.[id]?.name ?? id);
  const imageUrl = firstHit?.[id]?.image ?? null;

  return aligned.map((cells, rowIdx) => ({
    entityId: Number(id),
    name: rowIdx === 0 ? displayName : '',
    imageUrl: rowIdx === 0 ? imageUrl : null,
    kind,
    cells,
  }));
}

function entityMapsForSection(shows: ShowStaffBundle[], key: keyof ShowStaffBundle): CreditedEntityMap[] {
  return shows.map((show) => {
    if (key === 'studios') return show.studios;
    if (key === 'productionStaff') return show.productionStaff;
    return show.voiceActors;
  });
}

function entityKindForSection(key: keyof ShowStaffBundle): 'studio' | 'staff' | 'va' {
  if (key === 'studios') return 'studio';
  if (key === 'productionStaff') return 'staff';
  return 'va';
}

export type CompareSectionsOptions = {
  /** Union (true) vs intersection (false) — see SharedStaffForm.includeAll. */
  includeAll: boolean;
  /**
   * When false (default for the panel), the Production Staff section is
   * filtered to "key" roles only via `isKeyProductionRole`. Studios and VAs
   * are unaffected.
   */
  productionAllRoles: boolean;
};

function filterProductionMapToKeyRoles(map: CreditedEntityMap): CreditedEntityMap {
  const out: CreditedEntityMap = {};
  for (const [id, entity] of Object.entries(map)) {
    const keyRoles = entity.roles.filter((role) => isKeyProductionRole(role));
    if (keyRoles.length === 0) {
      continue;
    }
    out[id] = { ...entity, roles: keyRoles };
  }
  return out;
}

export function buildCompareSections(
  shows: ShowStaffBundle[],
  options: CompareSectionsOptions,
): SharedStaffSection[] {
  const { includeAll, productionAllRoles } = options;
  const sections: SharedStaffSection[] = [];
  // includeAll=true means union (threshold 1); false means intersection (every show).
  const threshold = includeAll ? 1 : shows.length;

  for (const section of SECTIONS) {
    let maps = entityMapsForSection(shows, section.key);
    if (section.key === 'productionStaff' && !productionAllRoles) {
      maps = maps.map(filterProductionMapToKeyRoles);
    }
    const kind = entityKindForSection(section.key);

    let ids = dictIntersection(maps, threshold);
    if (ids.length === 0) {
      continue;
    }

    if (section.key === 'studios') {
      ids = orderStudioEntityIds(maps, threshold);
    } else if (section.key === 'voiceActors') {
      ids = orderVaEntityIds(maps, threshold);
    }

    const rows: SharedStaffSectionRow[] = [];
    for (const id of ids) {
      rows.push(...entityRowsForCompare(maps, id, kind));
    }
    sections.push({ title: section.title, rows });
  }

  return sections;
}

export type ProductionFilmographyShow = {
  id: number;
  title: string;
  roles: string[];
  titleSource?: import('./sharedCreditsLogic').MediaTitleSource;
  coverImage?: string | null;
};

export function tallySingleShowMatches(options: {
  sourceShowId: number;
  productionStaff: CreditedEntityMap;
  filmographies: Record<number, ProductionFilmographyShow[]>;
  ignoredShowIds: Set<number>;
  topOverall: number;
  topCategory: number;
}): {
  topOverall: SharedStaffTopMatch[];
  byCategory: SharedStaffCategoryMatches[];
  topMatchMediaId: number | null;
  titlesById: Record<number, string>;
} {
  const {
    productionStaff,
    filmographies,
    ignoredShowIds,
    topOverall,
    topCategory,
  } = options;

  const showCounts = new Map<number, number>();
  const musicCounts = new Map<number, number>();
  const visualsCounts = new Map<number, number>();
  const writingCounts = new Map<number, number>();
  const titlesById: Record<number, string> = {};
  const coversById: Record<number, string | null> = {};

  for (const [staffKey, staffInfo] of Object.entries(productionStaff)) {
    const staffId = Number(staffKey);
    const showRoles = filmographies[staffId];
    if (!showRoles) {
      continue;
    }

    for (const show of showRoles) {
      titlesById[show.id] = show.title;
      if (show.coverImage) {
        coversById[show.id] = show.coverImage;
      }
    }

    const sourceRoles = staffInfo.roles;

    for (const show of showRoles) {
      if (ignoredShowIds.has(show.id)) {
        continue;
      }
      showCounts.set(show.id, (showCounts.get(show.id) ?? 0) + 1);
    }

    const bumpCategory = (
      bucket: ReadonlySet<string>,
      counter: Map<number, number>,
    ) => {
      if (!anyTrimmedRoleInSet(sourceRoles, bucket)) {
        return;
      }
      for (const show of showRoles) {
        if (ignoredShowIds.has(show.id)) {
          continue;
        }
        if (anyTrimmedRoleInSet(show.roles, bucket)) {
          counter.set(show.id, (counter.get(show.id) ?? 0) + 1);
        }
      }
    };

    bumpCategory(MUSIC_ROLES, musicCounts);
    bumpCategory(VISUALS_ROLES, visualsCounts);
    bumpCategory(WRITING_ROLES, writingCounts);
  }

  const toMatches = (counter: Map<number, number>, limit: number): SharedStaffTopMatch[] =>
    [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([mediaId, sharedStaffCount]) => ({
        mediaId,
        title: titlesById[mediaId] ?? String(mediaId),
        coverImage: coversById[mediaId] ?? null,
        sharedStaffCount,
      }));

  const topOverallList = toMatches(showCounts, topOverall);
  const topMatchMediaId = topOverallList[0]?.mediaId ?? null;

  const byCategory: SharedStaffCategoryMatches[] = [
    { label: 'music staff', matches: toMatches(musicCounts, topCategory) },
    { label: 'art/animation staff', matches: toMatches(visualsCounts, topCategory) },
    { label: 'writing staff', matches: toMatches(writingCounts, topCategory) },
  ].filter((block) => block.matches.length > 0);

  return {
    topOverall: topOverallList,
    byCategory,
    topMatchMediaId,
    titlesById,
  };
}

export function finalizeSharedStaffResult(
  shows: ShowStaffBundle[],
  options: CompareSectionsOptions,
  singleShowReport?: {
    sourceTitle: string;
    topOverall: SharedStaffTopMatch[];
    byCategory: SharedStaffCategoryMatches[];
  },
): SharedStaffResult {
  const sections = buildCompareSections(shows, options);
  if (sections.length === 0 && !singleShowReport) {
    return {
      kind: 'empty',
      message: options.includeAll
        ? 'No studios/staff/VAs found.'
        : 'No common studios/staff/VAs found!',
    };
  }

  return {
    kind: 'compare',
    shows: shows.map((s) => ({
      id: s.id,
      title: s.title,
      coverImage: s.coverImage ?? null,
    })),
    sections,
    singleShowReport,
  };
}
