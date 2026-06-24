import {
  alignRoleCellsAcrossShows,
  alignVaRoleCellsAcrossShows,
  dictDiffs,
  dictIntersection,
} from '../../lib/importers/anilist/toolsDictUtils';
import { parseLinesOnePerLine } from '../parseToolLines';
import {
  anyTrimmedRoleInSet,
  MUSIC_ROLES,
  trimProductionRole,
  VISUALS_ROLES,
  WRITING_ROLES,
} from '../../lib/importers/anilist/staffRoleBuckets';

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
  diffMode: boolean;
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

function compareByRelevanceOrder(
  maps: CreditedEntityMap[],
  idA: string,
  idB: string,
): number {
  const orderA = maps[0]?.[idA]?.relevanceOrder ?? Number.MAX_SAFE_INTEGER;
  const orderB = maps[0]?.[idB]?.relevanceOrder ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return Number(idA) - Number(idB);
}

function entityRowsForCompare(
  maps: CreditedEntityMap[],
  id: string,
  kind: 'studio' | 'staff' | 'va',
): SharedStaffSectionRow[] {
  const roleLists = maps.map((m) => m[id]?.roles ?? []);
  const aligned =
    kind === 'va'
      ? alignVaRoleCellsAcrossShows(
          maps.map((m) => {
            const entity = m[id];
            if (!entity) {
              return [];
            }
            const characterIds = entity.roleCharacterIds ?? [];
            return entity.roles.map((label, roleIdx) => ({
              characterId: characterIds[roleIdx] ?? -(roleIdx + 1),
              label,
            }));
          }),
        )
      : alignRoleCellsAcrossShows(roleLists);
  const displayName = normalizeStaffName(maps[0]?.[id]?.name ?? id);
  const imageUrl = maps[0]?.[id]?.image ?? null;

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

export function buildCompareSections(
  shows: ShowStaffBundle[],
  diffMode: boolean,
): SharedStaffSection[] {
  const sections: SharedStaffSection[] = [];

  for (const section of SECTIONS) {
    const maps = entityMapsForSection(shows, section.key);
    const kind = entityKindForSection(section.key);

    if (diffMode) {
      const diffs = dictDiffs(maps);
      const hasAny = diffs.some((ids) => ids.length > 0);
      if (!hasAny) {
        continue;
      }
      const rows: SharedStaffSectionRow[] = [];
      shows.forEach((_show, showIdx) => {
        for (const id of diffs[showIdx] ?? []) {
          const entity = maps[showIdx]?.[id];
          if (!entity) {
            continue;
          }
          const maxRoles = entity.roles.length || 1;
          for (let i = 0; i < maxRoles; i += 1) {
            const cells = shows.map(() => '');
            cells[showIdx] = entity.roles[i] ?? '';
            rows.push({
              entityId: Number(id),
              name: i === 0 ? entity.name : '',
              imageUrl: i === 0 ? (entity.image ?? null) : null,
              kind,
              cells,
            });
          }
        }
      });
      sections.push({ title: section.title, rows });
      continue;
    }

    let commonIds = dictIntersection(maps);
    if (commonIds.length === 0) {
      continue;
    }

    if (section.key === 'voiceActors') {
      commonIds = [...commonIds].sort((a, b) => compareByRelevanceOrder(maps, a, b));
    }

    const rows: SharedStaffSectionRow[] = [];
    for (const id of commonIds) {
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
    const trimmedSource = sourceRoles.map(trimProductionRole);

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

    void trimmedSource;
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
  form: Pick<SharedStaffForm, 'diffMode'>,
  singleShowReport?: {
    sourceTitle: string;
    topOverall: SharedStaffTopMatch[];
    byCategory: SharedStaffCategoryMatches[];
  },
): SharedStaffResult {
  const sections = buildCompareSections(shows, form.diffMode);
  if (sections.length === 0 && !singleShowReport) {
    return {
      kind: 'empty',
      message: form.diffMode
        ? 'No differing studios/staff/VAs found.'
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
