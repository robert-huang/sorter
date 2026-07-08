/**
 * Lazy ensure helpers — expand graph data on demand before reads.
 */

import type { AnilistImportContext } from './context';
import { hasKnownGraphCacheDate } from './graphConstants';
import { expandMediaRelations } from './expandMediaRelations';
import { expandCharacterMedia } from './expandCharacterMedia';
import { expandStaffFilmography } from './expandStaffFilmography';
import {
  expandAnilistMediaDetail,
  type ExpandAnilistMediaDetailOptions,
} from './lazyExpansion';
import {
  getMediaRelationsExpansionFetchedAt,
  hasCharacterMediaExpansion,
  hasStaffFilmography,
} from './graphQueries';
import {
  getMediaCastExpansionStatus,
  type MediaCastExpansionStatus,
} from './readQueries';
import { needsGraphDataRefresh } from './toolsFetchPolicy';

function needsCharactersSectionExpanded(
  status: MediaCastExpansionStatus | null,
  force: boolean,
): boolean {
  if (force) {
    return true;
  }
  if (!status) {
    return true;
  }
  return (
    !status.charactersComplete ||
    !hasKnownGraphCacheDate(status.charactersFetchedAt)
  );
}

async function needsStaffSectionExpanded(
  ctx: AnilistImportContext,
  mediaId: number,
  status: MediaCastExpansionStatus | null,
  force: boolean,
): Promise<boolean> {
  if (force) {
    return true;
  }
  if (!status) {
    return true;
  }
  if (
    !status.staffComplete ||
    !hasKnownGraphCacheDate(status.staffFetchedAt)
  ) {
    return true;
  }
  // Drive merge can mark staff_complete while media_staff is still empty.
  const rows = await ctx.db.exec(
    'SELECT 1 FROM media_staff WHERE media_id = ? LIMIT 1',
    [mediaId],
  );
  return rows.length === 0;
}

export async function ensureMediaCastExpanded(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandAnilistMediaDetailOptions = {},
): Promise<boolean> {
  const status = await getMediaCastExpansionStatus(ctx.db, mediaId);
  const scope = options.scope ?? 'all';
  const force = options.force ?? false;
  const needsCharacters =
    (scope === 'all' || scope === 'characters') &&
    needsCharactersSectionExpanded(status, force);
  const needsStaff =
    (scope === 'all' || scope === 'staff') &&
    (await needsStaffSectionExpanded(ctx, mediaId, status, force));

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

export type EnsureCharacterMediaOptions = {
  force?: boolean;
};

export async function ensureCharacterMedia(
  ctx: AnilistImportContext,
  characterId: number,
  options: EnsureCharacterMediaOptions = {},
): Promise<boolean> {
  if (!options.force && (await hasCharacterMediaExpansion(ctx.db, characterId))) {
    return true;
  }
  const result = await expandCharacterMedia(ctx, characterId, options);
  return result !== null;
}

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

export type EnsureMediaRelationsOptions = {
  force?: boolean;
};

export async function ensureMediaRelations(
  ctx: AnilistImportContext,
  mediaId: number,
  options: EnsureMediaRelationsOptions = {},
): Promise<boolean> {
  const force = options.force ?? false;
  const fetchedAt = await getMediaRelationsExpansionFetchedAt(ctx.db, mediaId);
  if (!needsGraphDataRefresh(fetchedAt, { forceRefresh: force })) {
    return true;
  }
  const result = await expandMediaRelations(ctx, mediaId, { force });
  return result !== null;
}
