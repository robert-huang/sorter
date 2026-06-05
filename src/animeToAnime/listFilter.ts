import type {
  AnimeFilmographyRow,
  MediaRelationRow,
  ProductionCreditRow,
} from '../lib/importers/anilist/graphQueries';
import { mediaTitleSearchParts } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  characterNameSearchParts,
  personNameSearchParts,
} from '../lib/importers/anilist/personDisplayLabel';
import {
  filmographyRolesSubtitle,
  groupedVaCreditSubtitle,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';

export function matchesListFilter(parts: readonly (string | null | undefined)[], needle: string): boolean {
  if (!needle) {
    return true;
  }
  return parts.some((part) => part && part.toLowerCase().includes(needle));
}

export function groupedVaCreditFilterParts(group: GroupedVaCreditRow): readonly string[] {
  const subtitle = groupedVaCreditSubtitle(group);
  const parts = [
    ...personNameSearchParts(group.staff),
    ...group.credits.flatMap((row) => characterNameSearchParts(row.character)),
  ];
  if (subtitle) {
    parts.push(subtitle);
  }
  return parts;
}

export function productionCreditFilterParts(row: ProductionCreditRow): readonly string[] {
  return [...personNameSearchParts(row.staff), ...row.roles];
}

export function filmographyFilterParts(row: AnimeFilmographyRow): readonly string[] {
  const roleLine = filmographyRolesSubtitle(row);
  const parts = [...mediaTitleSearchParts(row.media)];
  if (roleLine) {
    parts.push(roleLine);
  }
  return parts;
}

export function mediaRelationFilterParts(row: MediaRelationRow): readonly string[] {
  return [...mediaTitleSearchParts(row.media), row.relationType];
}
