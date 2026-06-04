/**
 * Lazy ensure helpers — expand graph data on demand before reads.
 */

import type { AnilistImportContext } from './context';
import { expandMediaRelations } from './expandMediaRelations';
import { expandStaffFilmography } from './expandStaffFilmography';
import {
  expandAnilistMediaDetail,
  type ExpandAnilistMediaDetailOptions,
} from './lazyExpansion';
import { hasStaffFilmography } from './graphQueries';
import { getMediaCastExpansionStatus } from './readQueries';

export async function ensureMediaCastExpanded(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandAnilistMediaDetailOptions = {},
): Promise<boolean> {
  const status = await getMediaCastExpansionStatus(ctx.db, mediaId);
  const scope = options.scope ?? 'all';
  const needsCharacters =
    (scope === 'all' || scope === 'characters') &&
    (!status || !status.charactersComplete || options.force);
  const needsStaff =
    (scope === 'all' || scope === 'staff') &&
    (!status || !status.staffComplete || options.force);

  if (!needsCharacters && !needsStaff) {
    return true;
  }

  const result = await expandAnilistMediaDetail(ctx, mediaId, {
    ...options,
    scope: needsCharacters && needsStaff ? 'all' : needsCharacters ? 'characters' : 'staff',
  });
  return result !== null;
}

export type EnsureStaffFilmographyOptions = {
  force?: boolean;
};

export async function ensureStaffFilmography(
  ctx: AnilistImportContext,
  staffId: number,
  options: EnsureStaffFilmographyOptions = {},
): Promise<boolean> {
  if (!options.force && (await hasStaffFilmography(ctx.db, staffId))) {
    return true;
  }
  const result = await expandStaffFilmography(ctx, staffId);
  return result !== null;
}

export async function ensureMediaRelations(
  ctx: AnilistImportContext,
  mediaId: number,
): Promise<boolean> {
  const result = await expandMediaRelations(ctx, mediaId);
  return result !== null;
}
