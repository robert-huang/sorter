import type { VaCreditRow } from '../lib/importers/anilist/graphQueries';
import type { VaListImageMode } from './preferences';

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
