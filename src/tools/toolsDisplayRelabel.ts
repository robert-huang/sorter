import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  pickCharacterName,
  pickPersonName,
  type PersonNameFields,
} from '../lib/importers/anilist/personDisplayLabel';
import { getToolsImportContext } from '../lib/importers/anilist/toolsImportContext';
import {
  readShowStaffBundleFromDb,
  readStaffImagesFromDb,
  readStaffShowMapFromDb,
} from '../lib/importers/anilist/toolsAnilistAccess';
import type { SeasonalShow } from './panels/seasonalScoresLogic';
import {
  buildSharedCreditsResult,
  type SharedCreditsForm,
  type SharedCreditsResult,
  type StaffRoleEntry,
  type StaffRoleLabelSource,
  type StaffRoleMode,
  type StaffShowMap,
} from './panels/sharedCreditsLogic';
import type { ToolStaffNameFields } from './panels/sharedCreditsApi';
import {
  finalizeSharedStaffResult,
  tallySingleShowMatches,
  type ProductionFilmographyShow,
  type SharedStaffForm,
  type SharedStaffTopMatch,
  type SharedStaffCategoryMatches,
  type ShowStaffBundle,
} from './panels/sharedStaffLogic';
import type { SharedStaffResult } from './panels/sharedStaffLogic';
import { getProductionAllRoles } from './toolsPreferences';

export function resolveStaffDisplayNames(
  fields: Record<number, PersonNameFields>,
): Record<number, string> {
  const names: Record<number, string> = {};
  for (const [id, row] of Object.entries(fields)) {
    names[Number(id)] = pickPersonName(row);
  }
  return names;
}

function relabelStaffRoleEntry(role: StaffRoleEntry): StaffRoleEntry {
  const source = role.labelSource;
  if (!source) {
    return role;
  }
  if (source.kind === 'production') {
    return { ...role, label: source.staffRole };
  }
  const characterName = pickCharacterName({
    id: source.characterId,
    name_full: source.characterNameFull,
    name_native: source.characterNameNative,
  });
  return {
    ...role,
    label: `${characterName} (${source.characterRole})`,
    characterId: source.characterId > 0 ? source.characterId : role.characterId,
  };
}

export function relabelStaffShowMap(map: StaffShowMap): StaffShowMap {
  const out: StaffShowMap = {};
  for (const [mediaId, entry] of Object.entries(map)) {
    const title = entry.titleSource
      ? pickMediaTitle(entry.titleSource)
      : entry.title;
    out[mediaId] = {
      ...entry,
      title,
      roles: entry.roles.map(relabelStaffRoleEntry),
    };
  }
  return out;
}

export function relabelSeasonalShows(shows: SeasonalShow[]): SeasonalShow[] {
  return shows.map((show) => {
    if (!show.titleSource) {
      return show;
    }
    return {
      ...show,
      title: pickMediaTitle(show.titleSource),
    };
  });
}

export async function reloadStaffShowMapsFromDb(
  staffIds: number[],
  roleMode: StaffRoleMode,
  fallback: StaffShowMap[],
): Promise<StaffShowMap[]> {
  const ctx = getToolsImportContext();
  const maps: StaffShowMap[] = [];
  for (let i = 0; i < staffIds.length; i += 1) {
    const staffId = staffIds[i]!;
    const fromDb = await readStaffShowMapFromDb(ctx.db, staffId, roleMode);
    maps.push(fromDb ?? relabelStaffShowMap(fallback[i] ?? {}));
  }
  return maps;
}

export type SharedCreditsRebuildSource = {
  staffIds: number[];
  staffNameFields: Record<number, ToolStaffNameFields>;
  lists: StaffShowMap[];
  roleMode: StaffRoleMode;
  form: Pick<
    SharedCreditsForm,
    'minMatches' | 'mainRoleOnly' | 'diffMode' | 'oldestFirst'
  >;
  userMediaIds: Set<string> | null;
  usernameMode: 'include' | 'exclude' | null;
};

export async function rebuildSharedCreditsResult(
  source: SharedCreditsRebuildSource,
): Promise<SharedCreditsResult> {
  const lists = await reloadStaffShowMapsFromDb(
    source.staffIds,
    source.roleMode,
    source.lists,
  );
  const ctx = getToolsImportContext();
  const images = await readStaffImagesFromDb(ctx.db, source.staffIds);
  const staffNameFields = { ...source.staffNameFields };
  for (const [id, image] of Object.entries(images)) {
    const staffId = Number(id);
    const row = staffNameFields[staffId];
    if (row && image && !row.image) {
      staffNameFields[staffId] = { ...row, image };
    }
  }
  return buildSharedCreditsResult(
    source.staffIds,
    staffNameFields,
    lists,
    source.form,
    source.userMediaIds,
    source.usernameMode,
  );
}

function relabelProductionFilmography(
  shows: ProductionFilmographyShow[],
): ProductionFilmographyShow[] {
  return shows.map((show) => ({
    ...show,
    title: show.titleSource ? pickMediaTitle(show.titleSource) : show.title,
    coverImage: show.coverImage ?? null,
  }));
}

export type SharedStaffRebuildSource = {
  bundles: ShowStaffBundle[];
  form: Pick<SharedStaffForm, 'includeAll'>;
  singleShow?: {
    sourceShowId: number;
    ignoredShowIds: number[];
    topMatchCount: number;
    filmographies: Record<number, ProductionFilmographyShow[]>;
    topMatchMediaId: number | null;
  };
};

function buildSharedStaffOptions(
  form: Pick<SharedStaffForm, 'includeAll'>,
): { includeAll: boolean; productionAllRoles: boolean } {
  return {
    includeAll: form.includeAll,
    productionAllRoles: getProductionAllRoles(),
  };
}

export async function rebuildSharedStaffResult(
  source: SharedStaffRebuildSource,
): Promise<SharedStaffResult> {
  const ctx = getToolsImportContext();
  const bundles: ShowStaffBundle[] = [];
  for (const bundle of source.bundles) {
    const fromDb = await readShowStaffBundleFromDb(ctx.db, bundle.id, bundle.title);
    bundles.push(fromDb ?? bundle);
  }

  let singleShowReport:
    | {
        sourceTitle: string;
        topOverall: SharedStaffTopMatch[];
        byCategory: SharedStaffCategoryMatches[];
      }
    | undefined;

  if (source.singleShow && bundles[0]) {
    const sourceBundle = bundles[0];
    const filmographies: Record<number, ProductionFilmographyShow[]> = {};
    for (const [staffId, shows] of Object.entries(source.singleShow.filmographies)) {
      filmographies[Number(staffId)] = relabelProductionFilmography(shows);
    }
    const tally = tallySingleShowMatches({
      sourceShowId: source.singleShow.sourceShowId,
      productionStaff: sourceBundle.productionStaff,
      filmographies,
      ignoredShowIds: new Set(source.singleShow.ignoredShowIds),
      topOverall: source.singleShow.topMatchCount,
      topCategory: 3,
    });
    singleShowReport = {
      sourceTitle: sourceBundle.title,
      topOverall: tally.topOverall,
      byCategory: tally.byCategory,
    };
    if (tally.topMatchMediaId && tally.topMatchMediaId !== bundles[1]?.id) {
      const topTitle =
        tally.titlesById[tally.topMatchMediaId] ?? String(tally.topMatchMediaId);
      const topBundle = await readShowStaffBundleFromDb(
        ctx.db,
        tally.topMatchMediaId,
        topTitle,
      );
      if (topBundle) {
        bundles.splice(1, bundles.length - 1, topBundle);
      }
    }
  }

  return finalizeSharedStaffResult(
    bundles,
    buildSharedStaffOptions(source.form),
    singleShowReport,
  );
}

/** Build a voice-role label source from API/DB fields. */
export function voiceRoleLabelSource(input: {
  characterId: number;
  characterNameFull: string | null;
  characterNameNative: string | null;
  characterRole: string;
}): StaffRoleLabelSource {
  return {
    kind: 'voice',
    characterId: input.characterId,
    characterNameFull: input.characterNameFull,
    characterNameNative: input.characterNameNative,
    characterRole: input.characterRole,
  };
}

/** Build a media title source for relabeling. */
export function mediaTitleSource(input: {
  id: number;
  title_english?: string | null;
  title_romaji?: string | null;
  title_native?: string | null;
}): {
  id: number;
  title_english: string | null;
  title_romaji: string | null;
  title_native: string | null;
} {
  return {
    id: input.id,
    title_english: input.title_english ?? null,
    title_romaji: input.title_romaji ?? null,
    title_native: input.title_native ?? null,
  };
}

/** Pick a show title from loose AniList title fields (live API shape). */
export function pickLooseMediaTitle(
  id: number,
  title: {
    english?: string | null;
    romaji?: string | null;
    native?: string | null;
  },
): string {
  return pickMediaTitle({
    id,
    title_english: title.english ?? null,
    title_romaji: title.romaji ?? null,
    title_native: title.native ?? null,
  });
}
