import type { VaCreditRow } from '../lib/importers/anilist/graphQueries';
import type { AnilistCharacterRole } from '../lib/importers/anilist/types';
import { formatCharacterCastCredit } from '../lib/importers/anilist/castRoleDisplay';
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
  return staff.name_full ?? staff.name_native ?? `Staff #${staff.id}`;
}

export type GroupedVaCreditRow = {
  staff: VaCreditRow['staff'];
  credits: VaCreditRow[];
};

export function vaCreditCharacterName(row: VaCreditRow): string {
  return row.character.name_full ?? row.character.name_native ?? `Character #${row.character.id}`;
}

/** Secondary line under the voice actor (character + cast role). */
export function vaCreditSubtitle(row: VaCreditRow): string | null {
  const staffName = vaCreditStaffName(row);
  const characterName = vaCreditCharacterName(row);
  if (characterName === staffName) {
    return null;
  }
  return formatCharacterCastCredit(characterName, row.characterRole);
}

/** Comma-separated character credits for a grouped voice-actor row. */
export function groupedVaCreditSubtitle(group: GroupedVaCreditRow): string | null {
  const lines = group.credits
    .map((row) => vaCreditSubtitle(row))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return null;
  }
  return lines.join(', ');
}

export function vaCreditListImage(row: VaCreditRow, mode: VaListImageMode): string | null {
  if (mode === 'character') {
    return row.character.image;
  }
  return row.staff.image;
}
