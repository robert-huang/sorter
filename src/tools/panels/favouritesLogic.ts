/**
 * Pure logic for the Favourites tool — port of `character_vas.py` scoring and
 * character/VA aggregation. Network I/O lives in `favouritesApi.ts`.
 */

import {
  getCharacterNameDisplayMode,
  getMediaTitleDisplayMode,
  getPersonNameDisplayMode,
  type MediaTitleDisplayMode,
  type PersonNameDisplayMode,
} from '../../lib/importers/anilist/displayPreferences';
import { pickMediaTitle as pickMediaTitleWithPrefs } from '../../lib/importers/anilist/mediaDisplayLabel';
import {
  pickCharacterName as pickCharacterNameFields,
  pickPersonName,
} from '../../lib/importers/anilist/personDisplayLabel';

export const FAVOURITES_TOP_N = 20;

/** Characters whose VA pairing should be excluded from stats. */
export const CHAR_VA_BLACKLIST: Readonly<Record<number, readonly number[]>> = {
  137070: [95241], // Lillia Aspley: [Rina Satou] (LN)
  121101: [109251], // Miyuki Shirogane: [You Taichi] (young)
  200292: [118738], // Yuuta Asamura: [Shizuka Ishigami] (young)
  20336: [95740], // Shigeru Fujiwara: [Nanee Katou] (young)
  164170: [95869], // Rika Honjouji: [Saori Hayami] (manga)
  127095: [107750], // Kei Asai: [Hibiki Yamamura] (young)
  286805: [112629], // Nika Nanaura: [Haruka Shiraishi] (temp replacement)
  2645: [95256], // Balsa Yonsa: [Naomi Shindou] (young)
  40591: [105013], // Jinta Yadomi: [Mutsumi Tamura] (young)
  4606: [95935], // Tomoya Okazaki: [Fuyuka Ooura] (young)
  47167: [95823], // Taichi Mashima: [Ayahi Takagaki] (young)
  1748: [95496], // Ran Mouri: [Wakana Yamazaki] (manga)
  // 1743: [95014], // Ai Haibara: [Megumi Hayashibara] (manga)
  4228: [95517], // Ayumi Yoshida: [Yukiko Iwai] (manga)
  3198: [95458], // Kazuha Tooyama: [Yuuko Miyamura] (manga)
};

/** Media ids excluded from character/VA stats. */
export const MEDIA_BLACKLIST = new Set<number>([
  14753, // Horimiya OVA
]);

export enum CharacterRoleTier {
  Main = 0,
  Supporting = 1,
  Background = 2,
  Unknown = 3,
}

const ROLE_RANK: Record<string, CharacterRoleTier> = {
  MAIN: CharacterRoleTier.Main,
  SUPPORTING: CharacterRoleTier.Supporting,
  BACKGROUND: CharacterRoleTier.Background,
};

export type FavouritesForm = {
  username: string;
};

export type FavouriteCharacterInput = {
  id: number;
  name: { full: string; native?: string | null };
  gender?: string | null;
  favourites?: number | null;
  dateOfBirth?: { year?: number | null; month?: number | null; day?: number | null } | null;
};

export type FavouriteStaffInput = {
  id: number;
  name: { full: string; native?: string | null };
  gender?: string | null;
  favourites?: number | null;
  image?: { large?: string | null } | null;
};

export type FavouriteCharacterRef = {
  id: number;
  name: string;
};

export type FavouritesSeriesMeta = {
  title: string;
  coverImage: string | null;
  characters: FavouriteCharacterRef[];
};

export type FavouritesSeriesRow = {
  mediaId: number;
  mediaType: 'ANIME' | 'MANGA';
  title: string;
  coverImage: string | null;
  characters: FavouriteCharacterRef[];
};

export type CharacterMediaEdge = {
  node: {
    id: number;
    title: {
      romaji?: string | null;
      native?: string | null;
      english?: string | null;
    };
    type: string;
    format?: string | null;
    coverImage?: { large?: string | null } | null;
  };
  characterRole: string;
  voiceActors: Array<{
    id: number;
    name: { full: string; native?: string | null };
    image?: { large?: string | null } | null;
  }>;
};

export type VaMediaEdge = {
  node: { id: number };
  characterRole?: string | null;
  characters: Array<{ id: number } | null> | null;
};

export type VaPercentRoleMode = 'all' | 'mainOnly';

/** Fixed sort dampening for main-role % so 1/1 does not dominate the ranking. */
export const MAIN_ROLE_PERCENT_DUMMY = 2;

export type VaPercentMeta = {
  vaTotalCharacterCounts: Record<number, number>;
  vaMainRoleCharacterCounts: Record<number, number>;
  characterRoleTierById: Record<number, CharacterRoleTier>;
  characterCount: number;
};

export type VaAccumulator = {
  id: number;
  name: string;
  imageUrl: string | null;
  count: number;
  rankSum: number;
  logScore: number;
  characters: FavouriteCharacterRef[];
};

export type VaRankRow = {
  staffId: number;
  name: string;
  imageUrl: string | null;
  displayValue: string;
  numericValue: number;
  characters: FavouriteCharacterRef[];
};

export type FavouritesResult = {
  characterCount: number;
  vaCount: number;
  numSeen: number;
  numMain: number;
  numFemaleSeen: number;
  byCount: VaRankRow[];
  byAvgRank: VaRankRow[];
  byLogScore: VaRankRow[];
  byPercent: VaRankRow[];
  vaPercentMeta: VaPercentMeta;
  gender: { female: FavouriteCharacterRef[]; male: FavouriteCharacterRef[]; other: FavouriteCharacterRef[] };
  roles: {
    main: FavouriteCharacterRef[];
    supporting: FavouriteCharacterRef[];
    background: FavouriteCharacterRef[];
    unknown: FavouriteCharacterRef[];
  };
  birthdays: Record<string, FavouriteCharacterRef[]>;
  seriesAnime: FavouritesSeriesRow[];
  seriesManga: FavouritesSeriesRow[];
  characterNames: string[];
  favouriteCharacters: Array<{ id: number; name: string; rank: number; gender: string | null }>;
  favouriteStaff: Array<{
    id: number;
    name: string;
    imageUrl: string | null;
    gender: string | null;
    matchedCount: number;
    matchedCharacters: FavouriteCharacterRef[];
  }>;
  /**
   * Names of characters whose VA appearances were truncated by the
   * bounded normal-Analyze fetch. Non-empty means stats may
   * under-report; UI should suggest Expand Roles for full data.
   */
  truncatedCharacterNames?: string[];
};

export function pickCharacterName(
  character: Pick<FavouriteCharacterInput, 'id' | 'name'>,
  characterMode: PersonNameDisplayMode = getCharacterNameDisplayMode(),
): string {
  return pickCharacterNameFields(
    {
      id: character.id,
      name_full: character.name.full,
      name_native: character.name.native ?? null,
    },
    characterMode,
  );
}

export function pickStaffName(
  staff: Pick<FavouriteStaffInput, 'id' | 'name'>,
  personMode: PersonNameDisplayMode = getPersonNameDisplayMode(),
): string {
  return pickPersonName(
    {
      id: staff.id,
      name_full: staff.name.full,
      name_native: staff.name.native ?? null,
    },
    personMode,
  );
}

export function pickFavouriteMediaTitle(
  mediaId: number,
  title: {
    romaji?: string | null;
    native?: string | null;
    english?: string | null;
  },
  mediaMode: MediaTitleDisplayMode = getMediaTitleDisplayMode(),
): string {
  return pickMediaTitleWithPrefs(
    {
      id: mediaId,
      title_romaji: title.romaji ?? null,
      title_english: title.english ?? null,
      title_native: title.native ?? null,
    },
    mediaMode,
  );
}

function isVaBlacklisted(charId: number, vaId: number): boolean {
  const blocked = CHAR_VA_BLACKLIST[charId];
  return blocked !== undefined && blocked.includes(vaId);
}

export function processCharacterEdges(
  charId: number,
  charName: string,
  edges: CharacterMediaEdge[],
  consumedMediaIds: ReadonlySet<number>,
): {
  charRole: CharacterRoleTier;
  seen: boolean;
  isMain: boolean;
  vas: Array<{ id: number; name: string; imageUrl: string | null }>;
  shows: Record<number, FavouritesSeriesMeta>;
  books: Record<number, FavouritesSeriesMeta>;
} {
  const vaIds = new Set<number>();
  const vas: Array<{ id: number; name: string; imageUrl: string | null }> = [];
  let charRole = CharacterRoleTier.Unknown;
  let seen = false;
  let isMain = false;
  const shows: Record<
    number,
    { title: string; coverImage: string | null; characters: Map<number, FavouriteCharacterRef> }
  > = {};
  const books: Record<
    number,
    { title: string; coverImage: string | null; characters: Map<number, FavouriteCharacterRef> }
  > = {};

  const charRef: FavouriteCharacterRef = { id: charId, name: charName };

  for (const edge of edges) {
    const mediaId = edge.node.id;
    if (!consumedMediaIds.has(mediaId) || MEDIA_BLACKLIST.has(mediaId)) {
      continue;
    }

    const title = pickFavouriteMediaTitle(mediaId, edge.node.title);
    const bucket = edge.node.type === 'MANGA' ? books : shows;
    if (!bucket[mediaId]) {
      bucket[mediaId] = {
        title,
        coverImage: edge.node.coverImage?.large ?? null,
        characters: new Map(),
      };
    }
    bucket[mediaId].characters.set(charId, charRef);

    const roleRank = ROLE_RANK[edge.characterRole] ?? CharacterRoleTier.Unknown;
    charRole = Math.min(charRole, roleRank) as CharacterRoleTier;
    seen = true;
    isMain = isMain || edge.characterRole === 'MAIN';

    for (const va of edge.voiceActors) {
      if (vaIds.has(va.id) || isVaBlacklisted(charId, va.id)) {
        continue;
      }
      vas.push({
        id: va.id,
        name: pickPersonName({
          id: va.id,
          name_full: va.name.full,
          name_native: va.name.native ?? null,
        }),
        imageUrl: va.image?.large ?? null,
      });
      vaIds.add(va.id);
    }
  }

  const toSeriesMeta = (
    map: Record<
      number,
      { title: string; coverImage: string | null; characters: Map<number, FavouriteCharacterRef> }
    >,
  ): Record<number, FavouritesSeriesMeta> =>
    Object.fromEntries(
      Object.entries(map).map(([mediaId, entry]) => [
        mediaId,
        {
          title: entry.title,
          coverImage: entry.coverImage,
          characters: [...entry.characters.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
      ]),
    );

  return {
    charRole,
    seen,
    isMain,
    vas,
    shows: toSeriesMeta(shows),
    books: toSeriesMeta(books),
  };
}

function roleTierFromLabel(role: string | null | undefined): CharacterRoleTier {
  return ROLE_RANK[role ?? ''] ?? CharacterRoleTier.Unknown;
}

/** Best (highest) role tier for each character on consumed media from VA filmography edges. */
export function collectVaCharacterRoleTiers(
  edges: VaMediaEdge[],
  consumedMediaIds: ReadonlySet<number>,
): Map<number, CharacterRoleTier> {
  const characterBestTier = new Map<number, CharacterRoleTier>();
  for (const edge of edges) {
    const mediaId = edge.node.id;
    if (!consumedMediaIds.has(mediaId) || MEDIA_BLACKLIST.has(mediaId)) {
      continue;
    }
    const roleTier = roleTierFromLabel(edge.characterRole);
    for (const character of edge.characters ?? []) {
      if (character?.id === undefined) {
        continue;
      }
      const existing = characterBestTier.get(character.id) ?? CharacterRoleTier.Unknown;
      characterBestTier.set(
        character.id,
        Math.min(existing, roleTier) as CharacterRoleTier,
      );
    }
  }
  return characterBestTier;
}

export function countVaCharactersOnMedia(
  edges: VaMediaEdge[],
  consumedMediaIds: ReadonlySet<number>,
  roleMode: VaPercentRoleMode = 'all',
): number {
  const characterBestTier = collectVaCharacterRoleTiers(edges, consumedMediaIds);
  if (roleMode === 'mainOnly') {
    return [...characterBestTier.values()].filter(
      (tier) => tier === CharacterRoleTier.Main,
    ).length;
  }
  return characterBestTier.size;
}

export type CharacterRoleOnMediaRow = {
  characterId: number;
  role: string | null;
};

/**
 * Best role tier per character across `media_character` rows on consumed
 * media. Used for main-role VA totals so a manga MAIN counts even when the
 * VA filmography edge only reflects an anime appearance.
 */
export function countMainRoleVaCharacters(
  voicedCharacterIds: ReadonlySet<number>,
  roleRows: CharacterRoleOnMediaRow[],
): number {
  const bestTier = new Map<number, CharacterRoleTier>();
  for (const row of roleRows) {
    if (!voicedCharacterIds.has(row.characterId)) {
      continue;
    }
    const roleTier = roleTierFromLabel(row.role);
    const existing = bestTier.get(row.characterId) ?? CharacterRoleTier.Unknown;
    bestTier.set(
      row.characterId,
      Math.min(existing, roleTier) as CharacterRoleTier,
    );
  }
  let count = 0;
  for (const characterId of voicedCharacterIds) {
    if (bestTier.get(characterId) === CharacterRoleTier.Main) {
      count += 1;
    }
  }
  return count;
}

export function formatBirthdayKey(
  dob: FavouriteCharacterInput['dateOfBirth'],
): string {
  if (dob?.month && dob?.day) {
    const month = String(dob.month).padStart(2, '0');
    const day = String(dob.day).padStart(2, '0');
    return `${month}${day}`;
  }
  return 'incomplete/missing data';
}

const BIRTHDAY_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export const BIRTHDAY_MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type BirthdayCalendarCell = {
  month: number;
  day: number;
  linearIndex: number;
  characters: FavouriteCharacterRef[];
};

export type BirthdayCalendarLayout = {
  cells: BirthdayCalendarCell[];
  incomplete: FavouriteCharacterRef[];
};

/** Continuous year grid: Jan 1 in column 0; each month follows the previous month's end column. */
export function buildBirthdayCalendarLayout(
  birthdays: Record<string, FavouriteCharacterRef[]>,
): BirthdayCalendarLayout {
  const byMonthDay = new Map<string, FavouriteCharacterRef[]>();
  const incomplete: FavouriteCharacterRef[] = [];

  for (const [key, characters] of Object.entries(birthdays)) {
    if (key === 'incomplete/missing data') {
      incomplete.push(...characters);
      continue;
    }
    byMonthDay.set(key, characters);
  }

  const cells: BirthdayCalendarCell[] = [];
  let linearIndex = 0;
  for (let month = 1; month <= 12; month += 1) {
    const daysInMonth = BIRTHDAY_DAYS_IN_MONTH[month - 1]!;
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      cells.push({
        month,
        day,
        linearIndex,
        characters: byMonthDay.get(key) ?? [],
      });
      linearIndex += 1;
    }
  }

  return { cells, incomplete };
}

export function mapToRecord(map: Map<number, number>): Record<number, number> {
  return Object.fromEntries(map.entries());
}

export function accumulateVaStats(
  characters: FavouriteCharacterInput[],
  perCharacterVas: Array<Array<{ id: number; name: string; imageUrl: string | null }>>,
  characterMode: PersonNameDisplayMode = getCharacterNameDisplayMode(),
): Map<number, VaAccumulator> {
  const dummyMedian = characters.length / 10;
  const midpoint = (characters.length / 2) * dummyMedian;
  const logBase = Math.log(characters.length);
  const accum = new Map<number, VaAccumulator>();

  for (let i = 0; i < characters.length; i += 1) {
    const rank = i + 1;
    const character = characters[i]!;
    const characterRef: FavouriteCharacterRef = {
      id: character.id,
      name: pickCharacterName(character, characterMode),
    };
    for (const va of perCharacterVas[i] ?? []) {
      const existing = accum.get(va.id);
      if (existing) {
        existing.count += 1;
        existing.rankSum += rank;
        existing.logScore += logBase - Math.log(rank);
        existing.characters.push(characterRef);
        if (!existing.imageUrl && va.imageUrl) {
          existing.imageUrl = va.imageUrl;
        }
      } else {
        accum.set(va.id, {
          id: va.id,
          name: va.name,
          imageUrl: va.imageUrl,
          count: dummyMedian + 1,
          rankSum: midpoint + rank,
          logScore: logBase - Math.log(rank),
          characters: [characterRef],
        });
      }
    }
  }

  return accum;
}

function toRankRows(
  accum: Map<number, VaAccumulator>,
  pick: (va: VaAccumulator) => { displayValue: string; numericValue: number },
  sort: (a: VaRankRow, b: VaRankRow) => number,
): VaRankRow[] {
  const rows: VaRankRow[] = [...accum.values()].map((va) => {
    const { displayValue, numericValue } = pick(va);
    return {
      staffId: va.id,
      name: va.name,
      imageUrl: va.imageUrl,
      displayValue,
      numericValue,
      characters: va.characters,
    };
  });
  rows.sort(sort);
  return rows;
}

export function buildVaPercentRankRows(
  byCountRows: VaRankRow[],
  meta: VaPercentMeta,
  roleMode: VaPercentRoleMode,
): VaRankRow[] {
  const dummyMedian =
    roleMode === 'mainOnly'
      ? MAIN_ROLE_PERCENT_DUMMY
      : meta.characterCount / 10;
  const totalCounts =
    roleMode === 'mainOnly'
      ? meta.vaMainRoleCharacterCounts
      : meta.vaTotalCharacterCounts;

  const rows: VaRankRow[] = byCountRows.map((row) => {
    const favoritedCharacters =
      roleMode === 'mainOnly'
        ? row.characters.filter(
            (character) =>
              meta.characterRoleTierById[character.id] === CharacterRoleTier.Main,
          )
        : row.characters;
    const favorited = favoritedCharacters.length;
    const total = totalCounts[row.staffId] ?? 0;
    const pct = total > 0 ? (100 * favorited) / total : 0;
    return {
      ...row,
      displayValue: `${Math.round(pct)}% (${favorited}/${total})`,
      numericValue: favorited / (total + dummyMedian),
      characters: favoritedCharacters,
    };
  });

  rows.sort((a, b) => b.numericValue - a.numericValue);
  return rows;
}

export function buildFavouritesResult(input: {
  characters: FavouriteCharacterInput[];
  perCharacterVas: Array<Array<{ id: number; name: string; imageUrl: string | null }>>;
  perCharacterMeta: Array<{
    charRole: CharacterRoleTier;
    seen: boolean;
    isMain: boolean;
    shows: Record<number, FavouritesSeriesMeta>;
    books: Record<number, FavouritesSeriesMeta>;
  }>;
  vaTotalCharacterCounts: Map<number, number>;
  vaMainRoleCharacterCounts: Map<number, number>;
  favouriteStaff: FavouriteStaffInput[];
  /** Character names whose normal-Analyze VA fetch hit the page cap. */
  truncatedCharacterNames?: string[];
}): FavouritesResult {
  const {
    characters,
    perCharacterVas,
    perCharacterMeta,
    vaTotalCharacterCounts,
    vaMainRoleCharacterCounts,
    favouriteStaff,
    truncatedCharacterNames,
  } = input;

  const dummyMedian = characters.length / 10;
  const accum = accumulateVaStats(characters, perCharacterVas);

  const characterNames = characters.map((c) => pickCharacterName(c));
  const favouriteCharacters = characters.map((character, index) => ({
    id: character.id,
    name: characterNames[index]!,
    rank: index + 1,
    gender: character.gender ?? null,
  }));
  const gender = {
    female: [] as FavouriteCharacterRef[],
    male: [] as FavouriteCharacterRef[],
    other: [] as FavouriteCharacterRef[],
  };
  const roles = {
    main: [] as FavouriteCharacterRef[],
    supporting: [] as FavouriteCharacterRef[],
    background: [] as FavouriteCharacterRef[],
    unknown: [] as FavouriteCharacterRef[],
  };
  const birthdays: Record<string, FavouriteCharacterRef[]> = {};
  const seriesAnimeById = new Map<number, FavouritesSeriesRow>();
  const seriesMangaById = new Map<number, FavouritesSeriesRow>();

  let numSeen = 0;
  let numMain = 0;
  let numFemaleSeen = 0;

  for (let i = 0; i < characters.length; i += 1) {
    const name = characterNames[i]!;
    const characterRef: FavouriteCharacterRef = { id: characters[i]!.id, name };
    const meta = perCharacterMeta[i];
    numSeen += meta.seen ? 1 : 0;
    numMain += meta.isMain ? 1 : 0;

    const g = (characters[i].gender ?? '').toLowerCase();
    if (meta.seen && g === 'female') {
      numFemaleSeen += 1;
    }
    if (g === 'female' || g === 'male') {
      gender[g].push(characterRef);
    } else {
      gender.other.push(characterRef);
    }

    switch (meta.charRole) {
      case CharacterRoleTier.Main:
        roles.main.push(characterRef);
        break;
      case CharacterRoleTier.Supporting:
        roles.supporting.push(characterRef);
        break;
      case CharacterRoleTier.Background:
        roles.background.push(characterRef);
        break;
      default:
        roles.unknown.push(characterRef);
        break;
    }

    const birthdayKey = formatBirthdayKey(characters[i].dateOfBirth);
    if (!birthdays[birthdayKey]) {
      birthdays[birthdayKey] = [];
    }
    birthdays[birthdayKey].push(characterRef);

    for (const [mediaIdStr, entry] of Object.entries(meta.shows)) {
      mergeSeriesRow(seriesAnimeById, Number(mediaIdStr), 'ANIME', entry);
    }
    for (const [mediaIdStr, entry] of Object.entries(meta.books)) {
      mergeSeriesRow(seriesMangaById, Number(mediaIdStr), 'MANGA', entry);
    }
  }

  const byCount = toRankRows(
    accum,
    (va) => ({
      displayValue: String(Math.round(va.count - dummyMedian)),
      numericValue: va.count - dummyMedian,
    }),
    (a, b) => b.numericValue - a.numericValue,
  );

  const byAvgRank = toRankRows(
    accum,
    (va) => ({
      displayValue: (va.rankSum / va.count).toFixed(1),
      numericValue: va.rankSum / va.count,
    }),
    (a, b) => a.numericValue - b.numericValue,
  );

  const byLogScore = toRankRows(
    accum,
    (va) => ({
      displayValue: (va.logScore * 10).toFixed(2),
      numericValue: va.logScore,
    }),
    (a, b) => b.numericValue - a.numericValue,
  );

  const byPercent = buildVaPercentRankRows(byCount, {
    vaTotalCharacterCounts: mapToRecord(vaTotalCharacterCounts),
    vaMainRoleCharacterCounts: mapToRecord(vaMainRoleCharacterCounts),
    characterRoleTierById: Object.fromEntries(
      characters.map((character, index) => [
        character.id,
        perCharacterMeta[index]!.charRole,
      ]),
    ),
    characterCount: characters.length,
  }, 'all');

  const vaPercentMeta: VaPercentMeta = {
    vaTotalCharacterCounts: mapToRecord(vaTotalCharacterCounts),
    vaMainRoleCharacterCounts: mapToRecord(vaMainRoleCharacterCounts),
    characterRoleTierById: Object.fromEntries(
      characters.map((character, index) => [
        character.id,
        perCharacterMeta[index]!.charRole,
      ]),
    ),
    characterCount: characters.length,
  };

  const staffRows = favouriteStaff.map((staff) => {
    const matchedCharacters = accum.get(staff.id)?.characters ?? [];
    return {
      id: staff.id,
      name: pickStaffName(staff),
      imageUrl:
        staff.image?.large ?? accum.get(staff.id)?.imageUrl ?? null,
      gender: staff.gender ?? null,
      matchedCount: matchedCharacters.length,
      matchedCharacters,
    };
  });

  return {
    characterCount: characters.length,
    vaCount: accum.size,
    numSeen,
    numMain,
    numFemaleSeen,
    byCount,
    byAvgRank,
    byLogScore,
    byPercent,
    vaPercentMeta,
    gender,
    roles,
    birthdays,
    seriesAnime: sortSeriesRows([...seriesAnimeById.values()], favouriteCharacters),
    seriesManga: sortSeriesRows([...seriesMangaById.values()], favouriteCharacters),
    characterNames,
    favouriteCharacters,
    favouriteStaff: staffRows,
    ...(truncatedCharacterNames && truncatedCharacterNames.length > 0
      ? { truncatedCharacterNames }
      : {}),
  };
}

export type FavouritesRebuildSource = {
  characters: FavouriteCharacterInput[];
  perCharacterEdges: CharacterMediaEdge[][];
  consumedMediaIds: ReadonlySet<number>;
  favouriteStaff: FavouriteStaffInput[];
  vaTotalCharacterCounts: Map<number, number>;
  vaMainRoleCharacterCounts: Map<number, number>;
  /** Set when a character's bounded VA fetch hit the page cap. */
  truncatedCharacterIds?: ReadonlySet<number>;
};

export function rebuildFavouritesResult(
  source: FavouritesRebuildSource,
): FavouritesResult {
  const perCharacterVas: Array<Array<{ id: number; name: string; imageUrl: string | null }>> = [];
  const perCharacterMeta: Array<{
    charRole: CharacterRoleTier;
    seen: boolean;
    isMain: boolean;
    shows: Record<number, FavouritesSeriesMeta>;
    books: Record<number, FavouritesSeriesMeta>;
  }> = [];

  for (let i = 0; i < source.characters.length; i += 1) {
    const character = source.characters[i]!;
    const processed = processCharacterEdges(
      character.id,
      pickCharacterName(character),
      source.perCharacterEdges[i] ?? [],
      source.consumedMediaIds,
    );
    perCharacterVas.push(processed.vas);
    perCharacterMeta.push({
      charRole: processed.charRole,
      seen: processed.seen,
      isMain: processed.isMain,
      shows: processed.shows,
      books: processed.books,
    });
  }

  const truncatedNames = source.truncatedCharacterIds
    ? source.characters
        .filter((c) => source.truncatedCharacterIds!.has(c.id))
        .map((c) => pickCharacterName(c))
    : undefined;

  return buildFavouritesResult({
    characters: source.characters,
    perCharacterVas,
    perCharacterMeta,
    vaTotalCharacterCounts: source.vaTotalCharacterCounts,
    vaMainRoleCharacterCounts: source.vaMainRoleCharacterCounts,
    favouriteStaff: source.favouriteStaff,
    ...(truncatedNames ? { truncatedCharacterNames: truncatedNames } : {}),
  });
}

function mergeSeriesRow(
  target: Map<number, FavouritesSeriesRow>,
  mediaId: number,
  mediaType: 'ANIME' | 'MANGA',
  entry: FavouritesSeriesMeta,
): void {
  let row = target.get(mediaId);
  if (!row) {
    row = {
      mediaId,
      mediaType,
      title: entry.title,
      coverImage: entry.coverImage,
      characters: [],
    };
    target.set(mediaId, row);
  }
  for (const character of entry.characters) {
    if (!row.characters.some((existing) => existing.id === character.id)) {
      row.characters.push(character);
    }
  }
}

function sortSeriesRows(
  rows: FavouritesSeriesRow[],
  favouriteOrder: Array<{ id: number }>,
): FavouritesSeriesRow[] {
  const orderById = new Map(favouriteOrder.map((character, index) => [character.id, index]));
  return rows
    .map((row) => ({
      ...row,
      characters: [...row.characters].sort(
        (a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0),
      ),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
