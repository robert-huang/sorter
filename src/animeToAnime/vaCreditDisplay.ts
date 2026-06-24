import type { AnimeFilmographyRow, VaCreditRow } from '../lib/importers/anilist/graphQueries';
import type { AnilistCharacterRole } from '../lib/importers/anilist/types';
import { formatCharacterCastCredit } from '../lib/importers/anilist/castRoleDisplay';
import { pickCharacterName, pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import type { VaListImageMode } from './preferences';

const CHARACTER_ROLE_ORDER: Record<AnilistCharacterRole, number> = {
  MAIN: 0,
  SUPPORTING: 1,
  BACKGROUND: 2,
};

/** Sort key matching {@link VA_CREDITS_ORDER_BY} in graphQueries. */
export function vaCreditRoleSortKey(role: string | null): number {
  if (role === 'MAIN' || role === 'SUPPORTING' || role === 'BACKGROUND') {
    return CHARACTER_ROLE_ORDER[role];
  }
  return 3;
}

export function compareVaCredits(a: VaCreditRow, b: VaCreditRow): number {
  const roleDiff = vaCreditRoleSortKey(a.characterRole) - vaCreditRoleSortKey(b.characterRole);
  if (roleDiff !== 0) {
    return roleDiff;
  }
  const orderDiff = a.characterSortOrder - b.characterSortOrder;
  if (orderDiff !== 0) {
    return orderDiff;
  }
  const staffA = vaCreditStaffName(a).toLocaleLowerCase();
  const staffB = vaCreditStaffName(b).toLocaleLowerCase();
  const staffDiff = staffA.localeCompare(staffB);
  if (staffDiff !== 0) {
    return staffDiff;
  }
  return a.character.id - b.character.id;
}

export function sortVaCredits(rows: VaCreditRow[]): VaCreditRow[] {
  return [...rows].sort(compareVaCredits);
}

/** One list row per voice actor; multiple characters on the same show are merged. */
export function groupSortedVaCredits(rows: VaCreditRow[]): GroupedVaCreditRow[] {
  const sorted = sortVaCredits(rows);
  const order: number[] = [];
  const byStaffId = new Map<number, GroupedVaCreditRow>();

  for (const row of sorted) {
    let group = byStaffId.get(row.staff.id);
    if (!group) {
      group = { staff: row.staff, credits: [] };
      byStaffId.set(row.staff.id, group);
      order.push(row.staff.id);
    }
    group.credits.push(row);
  }

  return order.map((id) => byStaffId.get(id)!);
}

export function vaCreditStaffName(row: VaCreditRow): string {
  return vaCreditStaffNameFromStaff(row.staff);
}

export function vaCreditStaffNameFromStaff(staff: VaCreditRow['staff']): string {
  return pickPersonName(staff, undefined, 'Staff');
}

export type GroupedVaCreditRow = {
  staff: VaCreditRow['staff'];
  credits: VaCreditRow[];
};

export function vaCreditCharacterName(row: VaCreditRow): string {
  return pickCharacterName(row.character, undefined, 'Character');
}

function stripLeadingAs(role: string): string {
  return role.startsWith('as ') ? role.slice(3) : role;
}

/** One `as` prefix, then comma-separated character/role credits. */
function voiceRolesAsSubtitle(roles: readonly string[]): string {
  return `as ${roles.map(stripLeadingAs).join(', ')}`;
}

/** Secondary line under the voice actor (character + cast role). */
export function vaCreditSubtitle(row: VaCreditRow): string | null {
  const staffName = vaCreditStaffName(row);
  const characterName = vaCreditCharacterName(row);
  if (characterName === staffName) {
    return null;
  }
  return voiceRolesAsSubtitle([
    formatCharacterCastCredit(characterName, row.characterRole),
  ]);
}

/**
 * Subtitle under a staff filmography row. Voice credits use `as …`; production
 * roles are comma-joined with no `as` prefix.
 */
export function filmographyRolesSubtitle(
  row: Pick<AnimeFilmographyRow, 'roles' | 'creditKind'>,
): string | null {
  if (row.roles.length === 0) {
    return null;
  }
  if (row.creditKind === 'voice') {
    return voiceRolesAsSubtitle(row.roles);
  }
  return row.roles.join(', ');
}

/** Comma-separated character credits for a grouped voice-actor row. */
export function groupedVaCreditSubtitle(group: GroupedVaCreditRow): string | null {
  const staffName = vaCreditStaffNameFromStaff(group.staff);
  const roles = group.credits
    .map((row) => {
      const characterName = vaCreditCharacterName(row);
      if (characterName === staffName) {
        return null;
      }
      return formatCharacterCastCredit(characterName, row.characterRole);
    })
    .filter((role): role is string => role !== null);
  if (roles.length === 0) {
    return null;
  }
  return voiceRolesAsSubtitle(roles);
}

export function vaCreditListImage(row: VaCreditRow, mode: VaListImageMode): string | null {
  if (mode === 'character') {
    return row.character.image;
  }
  return row.staff.image;
}
