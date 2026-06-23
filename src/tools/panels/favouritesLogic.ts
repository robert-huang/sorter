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
  137070: [95241],
  121101: [109251],
  200292: [118738],
  20336: [95740],
  164170: [95869],
  127095: [107750],
  286805: [112629],
  2645: [95256],
  40591: [105013],
  4606: [95935],
  47167: [95823],
  1748: [95496],
  1743: [95014],
  4228: [95517],
  3198: [95458],
};

/** Media ids excluded from character/VA stats. */
export const MEDIA_BLACKLIST = new Set<number>([14753]);

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
  };
  characterRole: string;
  voiceActors: Array<{ id: number; name: { full: string; native?: string | null } }>;
};

export type VaMediaEdge = {
  node: { id: number };
  characters: Array<{ id: number } | null> | null;
};

export type VaAccumulator = {
  id: number;
  name: string;
  count: number;
  rankSum: number;
  logScore: number;
  characterNames: string[];
  characterNamesWithRank: string[];
};

export type VaRankRow = {
  staffId: number;
  name: string;
  displayValue: string;
  numericValue: number;
  characterNames: string[];
  characterNamesWithRank: string[];
};

export type FavouritesResult = {
  characterCount: number;
  vaCount: number;
  numSeen: number;
  numMain: number;
  byCount: VaRankRow[];
  byAvgRank: VaRankRow[];
  byLogScore: VaRankRow[];
  byPercent: VaRankRow[];
  gender: { female: string[]; male: string[]; other: string[] };
  roles: {
    main: string[];
    supporting: string[];
    background: string[];
    unknown: string[];
  };
  birthdays: Record<string, string[]>;
  seriesAnime: Record<string, string[]>;
  seriesManga: Record<string, string[]>;
  characterNames: string[];
  favouriteStaff: Array<{
    id: number;
    name: string;
    gender: string | null;
    matchedCount: number;
  }>;
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
  vas: Array<{ id: number; name: string }>;
  shows: Record<string, string[]>;
  books: Record<string, string[]>;
} {
  const vaIds = new Set<number>();
  const vas: Array<{ id: number; name: string }> = [];
  let charRole = CharacterRoleTier.Unknown;
  let seen = false;
  let isMain = false;
  const shows: Record<string, Set<string>> = {};
  const books: Record<string, Set<string>> = {};

  for (const edge of edges) {
    const mediaId = edge.node.id;
    if (!consumedMediaIds.has(mediaId) || MEDIA_BLACKLIST.has(mediaId)) {
      continue;
    }

    const title = pickFavouriteMediaTitle(mediaId, edge.node.title);
    const bucket = edge.node.type === 'MANGA' ? books : shows;
    if (!bucket[title]) {
      bucket[title] = new Set();
    }
    bucket[title].add(charName);

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
      });
      vaIds.add(va.id);
    }
  }

  const toSortedArrays = (map: Record<string, Set<string>>): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(map).map(([key, value]) => [key, [...value].sort()]),
    );

  return {
    charRole,
    seen,
    isMain,
    vas,
    shows: toSortedArrays(shows),
    books: toSortedArrays(books),
  };
}

export function countVaCharactersOnMedia(
  edges: VaMediaEdge[],
  consumedMediaIds: ReadonlySet<number>,
): number {
  const characterIds = new Set<number>();
  for (const edge of edges) {
    if (!consumedMediaIds.has(edge.node.id)) {
      continue;
    }
    for (const character of edge.characters ?? []) {
      if (character?.id !== undefined && !characterIds.has(character.id)) {
        characterIds.add(character.id);
      }
    }
  }
  return characterIds.size;
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

export function accumulateVaStats(
  characters: FavouriteCharacterInput[],
  perCharacterVas: Array<Array<{ id: number; name: string }>>,
  characterMode: PersonNameDisplayMode = getCharacterNameDisplayMode(),
): Map<number, VaAccumulator> {
  const dummyMedian = characters.length / 10;
  const midpoint = (characters.length / 2) * dummyMedian;
  const logBase = Math.log(characters.length);
  const accum = new Map<number, VaAccumulator>();

  for (let i = 0; i < characters.length; i += 1) {
    const rank = i + 1;
    for (const va of perCharacterVas[i] ?? []) {
      const existing = accum.get(va.id);
      if (existing) {
        existing.count += 1;
        existing.rankSum += rank;
        existing.logScore += logBase - Math.log(rank);
        existing.characterNames.push(pickCharacterName(characters[i]!, characterMode));
        existing.characterNamesWithRank.push(
          `${pickCharacterName(characters[i]!, characterMode)} (${rank})`,
        );
      } else {
        accum.set(va.id, {
          id: va.id,
          name: va.name,
          count: dummyMedian + 1,
          rankSum: midpoint + rank,
          logScore: logBase - Math.log(rank),
          characterNames: [pickCharacterName(characters[i]!, characterMode)],
          characterNamesWithRank: [
            `${pickCharacterName(characters[i]!, characterMode)} (${rank})`,
          ],
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
  topN: number,
): VaRankRow[] {
  const rows: VaRankRow[] = [...accum.values()].map((va) => {
    const { displayValue, numericValue } = pick(va);
    return {
      staffId: va.id,
      name: va.name,
      displayValue,
      numericValue,
      characterNames: va.characterNames,
      characterNamesWithRank: va.characterNamesWithRank,
    };
  });
  rows.sort(sort);
  return rows.slice(0, topN);
}

export function buildFavouritesResult(input: {
  characters: FavouriteCharacterInput[];
  perCharacterVas: Array<Array<{ id: number; name: string }>>;
  perCharacterMeta: Array<{
    charRole: CharacterRoleTier;
    seen: boolean;
    isMain: boolean;
    shows: Record<string, string[]>;
    books: Record<string, string[]>;
  }>;
  vaTotalCharacterCounts: Map<number, number>;
  favouriteStaff: FavouriteStaffInput[];
  topN?: number;
}): FavouritesResult {
  const {
    characters,
    perCharacterVas,
    perCharacterMeta,
    vaTotalCharacterCounts,
    favouriteStaff,
    topN = FAVOURITES_TOP_N,
  } = input;

  const dummyMedian = characters.length / 10;
  const accum = accumulateVaStats(characters, perCharacterVas);

  const characterNames = characters.map((c) => pickCharacterName(c));
  const gender = { female: [] as string[], male: [] as string[], other: [] as string[] };
  const roles = {
    main: [] as string[],
    supporting: [] as string[],
    background: [] as string[],
    unknown: [] as string[],
  };
  const birthdays: Record<string, string[]> = {};
  const seriesAnime: Record<string, string[]> = {};
  const seriesManga: Record<string, string[]> = {};

  let numSeen = 0;
  let numMain = 0;

  for (let i = 0; i < characters.length; i += 1) {
    const name = characterNames[i];
    const meta = perCharacterMeta[i];
    numSeen += meta.seen ? 1 : 0;
    numMain += meta.isMain ? 1 : 0;

    const g = (characters[i].gender ?? '').toLowerCase();
    if (g === 'female' || g === 'male') {
      gender[g].push(name);
    } else {
      gender.other.push(name);
    }

    switch (meta.charRole) {
      case CharacterRoleTier.Main:
        roles.main.push(name);
        break;
      case CharacterRoleTier.Supporting:
        roles.supporting.push(name);
        break;
      case CharacterRoleTier.Background:
        roles.background.push(name);
        break;
      default:
        roles.unknown.push(name);
        break;
    }

    const birthdayKey = formatBirthdayKey(characters[i].dateOfBirth);
    if (!birthdays[birthdayKey]) {
      birthdays[birthdayKey] = [];
    }
    birthdays[birthdayKey].push(name);

    for (const [title, chars] of Object.entries(meta.shows)) {
      if (!seriesAnime[title]) {
        seriesAnime[title] = [];
      }
      for (const c of chars) {
        if (!seriesAnime[title].includes(c)) {
          seriesAnime[title].push(c);
        }
      }
    }
    for (const [title, chars] of Object.entries(meta.books)) {
      if (!seriesManga[title]) {
        seriesManga[title] = [];
      }
      for (const c of chars) {
        if (!seriesManga[title].includes(c)) {
          seriesManga[title].push(c);
        }
      }
    }
  }

  const byCount = toRankRows(
    accum,
    (va) => ({
      displayValue: String(Math.round(va.count - dummyMedian)),
      numericValue: va.count - dummyMedian,
    }),
    (a, b) => b.numericValue - a.numericValue,
    topN,
  );

  const byAvgRank = toRankRows(
    accum,
    (va) => ({
      displayValue: (va.rankSum / va.count).toFixed(1),
      numericValue: va.rankSum / va.count,
    }),
    (a, b) => a.numericValue - b.numericValue,
    topN,
  );

  const byLogScore = toRankRows(
    accum,
    (va) => ({
      displayValue: (va.logScore * 10).toFixed(2),
      numericValue: va.logScore,
    }),
    (a, b) => b.numericValue - a.numericValue,
    topN,
  );

  const byPercent = toRankRows(
    accum,
    (va) => {
      const total = vaTotalCharacterCounts.get(va.id) ?? 0;
      const favorited = va.count - dummyMedian;
      const pct = total > 0 ? (100 * favorited) / total : 0;
      return {
        displayValue: `${Math.round(pct)}% (${Math.round(favorited)}/${total})`,
        numericValue:
          favorited / (total + characters.length / 10),
      };
    },
    (a, b) => b.numericValue - a.numericValue,
    topN,
  );

  const staffRows = favouriteStaff.map((staff) => ({
    id: staff.id,
    name: pickStaffName(staff),
    gender: staff.gender ?? null,
    matchedCount: accum.get(staff.id)?.characterNames.length ?? 0,
  }));

  return {
    characterCount: characters.length,
    vaCount: accum.size,
    numSeen,
    numMain,
    byCount,
    byAvgRank,
    byLogScore,
    byPercent,
    gender,
    roles,
    birthdays,
    seriesAnime: sortSeriesMap(seriesAnime, characterNames),
    seriesManga: sortSeriesMap(seriesManga, characterNames),
    characterNames,
    favouriteStaff: staffRows,
  };
}

function sortSeriesMap(
  map: Record<string, string[]>,
  characterNames: string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [title, names] of Object.entries(map)) {
    out[title] = [...names].sort(
      (a, b) => characterNames.indexOf(a) - characterNames.indexOf(b),
    );
  }
  return out;
}
