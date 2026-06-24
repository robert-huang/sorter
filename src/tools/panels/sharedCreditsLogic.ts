import { dictDiffs, dictIntersection } from '../../lib/importers/anilist/toolsDictUtils';
import { pickMediaTitle as pickMediaTitleWithPrefs } from '../../lib/importers/anilist/mediaDisplayLabel';
import { parseLinesOnePerLine } from '../parseToolLines';

export type StaffRoleMode = 'voice' | 'production';

export type StaffRoleEntry = {
  label: string;
  characterId?: number;
};

export type StaffShowEntry = {
  title: string;
  coverImage: string | null;
  roles: StaffRoleEntry[];
  startDate: string;
};

export function formatStaffRoleLabel(role: StaffRoleEntry): string {
  return role.label;
}

/** Map of media id (string) → show + roles for one staff member. */
export type StaffShowMap = Record<string, StaffShowEntry>;

export type SharedCreditsForm = {
  staffText: string;
  useIds: boolean;
  roleMode: StaffRoleMode;
  minMatches: number | null;
  mainRoleOnly: boolean;
  usernameInclude: string;
  usernameExclude: string;
  diffMode: boolean;
  oldestFirst: boolean;
};

export type SharedCreditsTableRow = {
  mediaId: number;
  title: string;
  coverImage: string | null;
  /** One role list per staff column (no cross-column alignment). */
  cells: StaffRoleEntry[][];
};

export type SharedCreditsDiffBlock = {
  staffId: number;
  staffName: string;
  shows: Array<{ mediaId: number; title: string; rolesLabel: string }>;
};

export type SharedCreditsResult =
  | { kind: 'empty'; message: string }
  | { kind: 'diff'; blocks: SharedCreditsDiffBlock[] }
  | { kind: 'table'; staffIds: number[]; staffNames: string[]; rows: SharedCreditsTableRow[] };

type StartDateParts = {
  year?: number | null;
  month?: number | null;
  day?: number | null;
};

export function parseStaffInputs(text: string, _useIds?: boolean): string[] {
  return parseLinesOnePerLine(text);
}

export function formatStartDateKey(date: StartDateParts): string {
  const year = date.year ? String(date.year).padStart(4, '0') : '9999';
  const month = date.month ? String(date.month).padStart(2, '0') : '99';
  const day = date.day ? String(date.day).padStart(2, '0') : '99';
  return `${year}${month}${day}`;
}

export function pickMediaTitle(title: {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
}): string {
  return pickMediaTitleWithPrefs({
    id: 0,
    title_english: title.english ?? null,
    title_romaji: title.romaji ?? null,
    title_native: title.native ?? null,
  });
}

export function filterMainRoles(map: StaffShowMap): StaffShowMap {
  const out: StaffShowMap = {};
  for (const [mediaId, entry] of Object.entries(map)) {
    const roles = entry.roles.filter((role) => role.label.includes('(MAIN)'));
    if (roles.length > 0) {
      out[mediaId] = { ...entry, roles };
    }
  }
  return out;
}

export function applyUsernameMediaFilter(
  mediaIds: string[],
  userMediaIds: Set<string> | null,
  mode: 'include' | 'exclude' | null,
): string[] {
  if (!userMediaIds || !mode) {
    return mediaIds;
  }
  if (mode === 'include') {
    return mediaIds.filter((id) => userMediaIds.has(id));
  }
  return mediaIds.filter((id) => !userMediaIds.has(id));
}

export function buildSharedCreditsResult(
  staffIds: number[],
  staffNames: Record<number, string>,
  lists: StaffShowMap[],
  form: Pick<
    SharedCreditsForm,
    'minMatches' | 'mainRoleOnly' | 'diffMode' | 'oldestFirst'
  >,
  userMediaIds: Set<string> | null,
  usernameMode: 'include' | 'exclude' | null,
): SharedCreditsResult {
  const processed = form.mainRoleOnly
    ? lists.map((list) => filterMainRoles(list))
    : lists;

  if (form.diffMode) {
    const diffs = dictDiffs(processed);
    const blocks: SharedCreditsDiffBlock[] = [];
    staffIds.forEach((staffId, idx) => {
      const uniqueIds = diffs[idx] ?? [];
      if (uniqueIds.length === 0) {
        return;
      }
      blocks.push({
        staffId,
        staffName: staffNames[staffId] ?? String(staffId),
        shows: uniqueIds.map((mediaId) => {
          const entry = processed[idx]?.[mediaId];
          return {
            mediaId: Number(mediaId),
            title: entry?.title ?? mediaId,
            rolesLabel: entry?.roles.map(formatStaffRoleLabel).join(', ') ?? '',
          };
        }),
      });
    });
    if (blocks.length === 0) {
      return { kind: 'empty', message: 'No unique shows per staff in diff mode.' };
    }
    return { kind: 'diff', blocks };
  }

  const threshold = form.minMatches ?? staffIds.length;
  let sharedIds = dictIntersection(processed, threshold);
  sharedIds = applyUsernameMediaFilter(sharedIds, userMediaIds, usernameMode);

  if (sharedIds.length === 0) {
    const suffix = form.mainRoleOnly ? ' with main roles' : '';
    return {
      kind: 'empty',
      message: `No shared anime${suffix} between these staff.`,
    };
  }

  const releaseDates: Record<string, string> = {};
  const titles: Record<string, string> = {};
  const coverImages: Record<string, string | null> = {};
  for (const list of processed) {
    for (const [mediaId, entry] of Object.entries(list)) {
      releaseDates[mediaId] = entry.startDate;
      titles[mediaId] = entry.title;
      if (coverImages[mediaId] == null && entry.coverImage) {
        coverImages[mediaId] = entry.coverImage;
      }
    }
  }

  sharedIds.sort((a, b) => {
    const cmp = releaseDates[a]!.localeCompare(releaseDates[b]!);
    return form.oldestFirst ? cmp : -cmp;
  });

  const rows: SharedCreditsTableRow[] = sharedIds.map((mediaId) => ({
    mediaId: Number(mediaId),
    title: titles[mediaId]!,
    coverImage: coverImages[mediaId] ?? null,
    cells: processed.map((list) => list[mediaId]?.roles ?? []),
  }));

  return {
    kind: 'table',
    staffIds,
    staffNames: staffIds.map((id) => staffNames[id] ?? String(id)),
    rows,
  };
}
