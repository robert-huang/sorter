/**
 * Lazy ensure helpers — expand graph data on demand before reads.
 */

import type { AnilistImportContext } from './context';
import { hasKnownGraphCacheDate } from './graphConstants';
import { expandMediaRelations } from './expandMediaRelations';
import { expandCharacterMedia } from './expandCharacterMedia';
import { expandStaffFilmography } from './expandStaffFilmography';
import {
  expandCharacterMediaBatch,
  expandStaffFilmographyBatch,
} from './expandGraphBatch';
import {
  expandMediaCastWithFallback,
  type ExpandMediaCastBatchOptions,
} from './expandMediaCastBatch';
import {
  expandAnilistMediaDetail,
  type ExpandAnilistMediaDetailOptions,
} from './lazyExpansion';
import type { ExpandStaffFilmographyOptions } from './expandStaffFilmography';
import {
  getMediaRelationsExpansionFetchedAt,
  getCharacterMediaFetchedAt,
  getStaffFilmographyFetchedAt,
  hasCharacterMediaExpansion,
  hasStaffFilmography,
} from './graphQueries';
import {
  getMediaCastExpansionStatus,
  type MediaCastExpansionStatus,
} from './readQueries';
import type { ToolsFetchOptions } from './toolsFetchPolicy';
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

export type EnsureMediaCastBatchOptions = ExpandAnilistMediaDetailOptions &
  Pick<ExpandMediaCastBatchOptions, 'batchSize'> & {
    /** When set, applies the same 90d staleness gate as `ensureMediaCastFresh`. */
    staleRefresh?: ToolsFetchOptions;
  };

export async function ensureMediaCastExpandedBatch(
  ctx: AnilistImportContext,
  mediaIds: readonly number[],
  options: EnsureMediaCastBatchOptions = {},
): Promise<void> {
  const scope = options.scope ?? 'all';
  const forceGlobal = options.force ?? false;
  const pending: Array<{ mediaId: number; scope: 'all' | 'characters' | 'staff' }> = [];

  for (const mediaId of [...new Set(mediaIds)]) {
    const status = await getMediaCastExpansionStatus(ctx.db, mediaId);
    const force =
      forceGlobal ||
      (options.staleRefresh
        ? (options.staleRefresh.forceRefresh ?? false) ||
          !status ||
          !status.charactersComplete ||
          !status.staffComplete ||
          needsGraphDataRefresh(status.charactersFetchedAt, options.staleRefresh) ||
          needsGraphDataRefresh(status.staffFetchedAt, options.staleRefresh)
        : false);
    const needsCharacters =
      (scope === 'all' || scope === 'characters') &&
      needsCharactersSectionExpanded(status, force);
    const needsStaff =
      (scope === 'all' || scope === 'staff') &&
      (await needsStaffSectionExpanded(ctx, mediaId, status, force));
    if (!needsCharacters && !needsStaff) {
      continue;
    }
    pending.push({
      mediaId,
      scope: needsCharacters && needsStaff ? 'all' : needsCharacters ? 'characters' : 'staff',
    });
  }

  if (pending.length === 0) {
    return;
  }

  await expandMediaCastWithFallback(ctx, pending, options);
}

export type EnsureStaffFilmographyOptions = ExpandStaffFilmographyOptions & {
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
    const fetchedAt = await getCharacterMediaFetchedAt(ctx.db, characterId);
    if (!needsGraphDataRefresh(fetchedAt, { forceRefresh: false })) {
      return true;
    }
  }
  const result = await expandCharacterMedia(ctx, characterId, options);
  return result !== null;
}

export async function ensureCharacterMediaBatch(
  ctx: AnilistImportContext,
  characterIds: readonly number[],
  options: EnsureCharacterMediaOptions = {},
): Promise<void> {
  const pending: number[] = [];
  for (const characterId of characterIds) {
    if (
      !options.force &&
      (await hasCharacterMediaExpansion(ctx.db, characterId)) &&
      !needsGraphDataRefresh(
        await getCharacterMediaFetchedAt(ctx.db, characterId),
        { forceRefresh: false },
      )
    ) {
      continue;
    }
    pending.push(characterId);
  }
  if (pending.length === 0) {
    return;
  }
  try {
    await expandCharacterMediaBatch(ctx, pending, options);
  } catch {
    for (const characterId of pending) {
      await expandCharacterMedia(ctx, characterId, options);
    }
  }
}

export async function ensureStaffFilmography(
  ctx: AnilistImportContext,
  staffId: number,
  options: EnsureStaffFilmographyOptions = {},
): Promise<boolean> {
  if (!options.force && (await hasStaffFilmography(ctx.db, staffId))) {
    const fetchedAt = await getStaffFilmographyFetchedAt(ctx.db, staffId);
    if (!needsGraphDataRefresh(fetchedAt, { forceRefresh: false })) {
      return true;
    }
  }
  const result = await expandStaffFilmography(ctx, staffId, options);
  return result !== null;
}

export async function ensureStaffFilmographyBatch(
  ctx: AnilistImportContext,
  staffIds: readonly number[],
  options: EnsureStaffFilmographyOptions = {},
): Promise<void> {
  const pending: number[] = [];
  for (const staffId of staffIds) {
    if (
      !options.force &&
      (await hasStaffFilmography(ctx.db, staffId)) &&
      !needsGraphDataRefresh(await getStaffFilmographyFetchedAt(ctx.db, staffId), {
        forceRefresh: false,
      })
    ) {
      continue;
    }
    pending.push(staffId);
  }
  if (pending.length === 0) {
    return;
  }
  try {
    await expandStaffFilmographyBatch(ctx, pending, options);
  } catch {
    for (const staffId of pending) {
      await expandStaffFilmography(ctx, staffId, options);
    }
  }
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
  // expandMediaRelations always replaces the outbound edge set from the fresh
  // response, so the marker gate above is the only thing `force` controls here.
  const result = await expandMediaRelations(ctx, mediaId);
  return result !== null;
}
