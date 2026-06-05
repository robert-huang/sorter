import type {
  AnimeFilmographyRow,
  MediaRelationRow,
  ProductionCreditRow,
} from '../lib/importers/anilist/graphQueries';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  filmographyRolesSubtitle,
  groupedVaCreditSubtitle,
  vaCreditStaffNameFromStaff,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';

export function matchesListFilter(parts: readonly (string | null | undefined)[], needle: string): boolean {
  if (!needle) {
    return true;
  }
  return parts.some((part) => part && part.toLowerCase().includes(needle));
}

export function groupedVaCreditFilterParts(group: GroupedVaCreditRow): readonly string[] {
  const name = vaCreditStaffNameFromStaff(group.staff);
  const subtitle = groupedVaCreditSubtitle(group);
  return subtitle ? [name, subtitle] : [name];
}

export function productionCreditFilterParts(row: ProductionCreditRow): readonly string[] {
  const name = row.staff.name_full ?? row.staff.name_native ?? '';
  return [name, ...row.roles];
}

export function filmographyFilterParts(row: AnimeFilmographyRow): readonly string[] {
  const title = pickMediaTitle(row.media);
  const roleLine = filmographyRolesSubtitle(row);
  return roleLine ? [title, roleLine] : [title];
}

export function mediaRelationFilterParts(row: MediaRelationRow): readonly string[] {
  return [pickMediaTitle(row.media), row.relationType];
}
