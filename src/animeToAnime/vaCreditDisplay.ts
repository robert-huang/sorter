import type { VaCreditRow } from '../lib/importers/anilist/graphQueries';
import type { AnilistCharacterRole } from '../lib/importers/anilist/types';
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

export function vaCreditStaffName(row: VaCreditRow): string {
  return row.staff.name_full ?? row.staff.name_native ?? `Staff #${row.staff.id}`;
}

export function vaCreditCharacterName(row: VaCreditRow): string {
  return row.character.name_full ?? row.character.name_native ?? `Character #${row.character.id}`;
}

/** Secondary line under the voice actor (character + cast role). */
export function vaCreditSubtitle(row: VaCreditRow): string | null {
  const staffName = vaCreditStaffName(row);
  const characterName = vaCreditCharacterName(row);
  const parts: string[] = [];
  if (characterName !== staffName) {
    parts.push(`as ${characterName}`);
  }
  if (row.characterRole) {
    parts.push(row.characterRole);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function vaCreditListImage(row: VaCreditRow, mode: VaListImageMode): string | null {
  if (mode === 'character') {
    return row.character.image;
  }
  return row.staff.image;
}
