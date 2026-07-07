import {
  findAnilistAccountByName,
  requireAccessTokenForUsername,
} from '../../lib/importers/anilist/anilistAuth';
import { makeAnilistImportContext } from '../../lib/importers/anilist/context';
import {
  buildToggleFavouriteMutation,
  buildUpdateFavouriteOrderMutation,
  favouriteOrderPayload,
  FAVOURITE_MUTATION_FIELDS,
  type ToggleFavouriteResponse,
  type UpdateFavouriteOrderResponse,
} from '../../lib/importers/anilist/favouriteMutations';
import { getAnilistUserByName, getFavouritesAsItems } from '../../lib/importers/anilist/readQueries';
import { runAnilistFavourites } from '../../lib/importers/anilist/runners';
import { getToolsImportContext } from '../../lib/importers/anilist/toolsImportContext';
import type { AnilistFavouriteType } from '../../lib/importers/anilist/types';
import type { AnilistProgressReporter } from '../../lib/importers/anilist/progress';
import {
  itemsWithSortOrder,
  type FavouriteListItem,
  type ReorderFavouritesForm,
} from './reorderFavouritesLogic';

export type LoadFavouritesResult = {
  items: FavouriteListItem[];
  anilistUserId: number;
};

export async function loadFavouritesFresh(
  form: ReorderFavouritesForm,
  onProgress?: AnilistProgressReporter,
  signal?: AbortSignal,
): Promise<LoadFavouritesResult> {
  signal?.throwIfAborted();
  const username = form.username.trim();
  if (!username) {
    throw new Error('Enter an AniList username.');
  }

  await runAnilistFavourites(username, form.favouriteType, onProgress);
  signal?.throwIfAborted();

  const ctx = getToolsImportContext();
  const user = await getAnilistUserByName(ctx.db, username);
  if (!user) {
    throw new Error(`AniList user "${username}" not found after import.`);
  }

  const rows = await getFavouritesAsItems(ctx.db, user.id, form.favouriteType);
  const items = itemsWithSortOrder(
    rows.map((row, index) => ({
      id: row.externalId,
      label: row.label,
      imageUrl: row.imageUrl,
      sortOrder: index,
      anilistLabelSource: row.anilistLabelSource,
    })),
  );

  return { items, anilistUserId: user.id };
}

export async function patchFavouriteSortOrderInCache(
  anilistUserId: number,
  type: AnilistFavouriteType,
  orderedIds: readonly number[],
): Promise<void> {
  const ctx = getToolsImportContext();
  const fields = FAVOURITE_MUTATION_FIELDS[type];
  const now = ctx.now();

  const mediaTypeClause =
    fields.mediaType != null
      ? ` AND ${fields.idColumn} IN (SELECT id FROM media WHERE type = ?)`
      : '';
  const mediaTypeParams = fields.mediaType != null ? [fields.mediaType] : [];

  const statements = orderedIds.map((entityId, index) => ({
    sql: `UPDATE ${fields.table}
            SET sort_order = ?, fetched_at = ?
          WHERE anilist_user_id = ?
            AND ${fields.idColumn} = ?${mediaTypeClause}`,
    params: [index, now, anilistUserId, entityId, ...mediaTypeParams] as const,
  }));

  await ctx.db.execBatch(statements);

  await ctx.onDirtyIncrement?.();
}

export async function removeFavouritesFromCache(
  anilistUserId: number,
  type: AnilistFavouriteType,
  entityIds: readonly number[],
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }
  const ctx = getToolsImportContext();
  const fields = FAVOURITE_MUTATION_FIELDS[type];
  const placeholders = entityIds.map(() => '?').join(', ');
  const mediaTypeClause =
    fields.mediaType != null
      ? ` AND ${fields.idColumn} IN (SELECT id FROM media WHERE type = ?)`
      : '';
  const mediaTypeParams = fields.mediaType != null ? [fields.mediaType] : [];

  await ctx.db.exec(
    `DELETE FROM ${fields.table}
      WHERE anilist_user_id = ?
        AND ${fields.idColumn} IN (${placeholders})${mediaTypeClause}`,
    [anilistUserId, ...entityIds, ...mediaTypeParams],
  );
  await ctx.onDirtyIncrement?.();
}

export async function saveFavouriteOrder(
  form: ReorderFavouritesForm,
  anilistUserId: number,
  items: readonly FavouriteListItem[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const username = form.username.trim();
  const account = findAnilistAccountByName(username);
  const accessToken = requireAccessTokenForUsername(username);
  const orderedIds = items.map((item) => item.id);
  const payload = favouriteOrderPayload(orderedIds);

  const ctx = makeAnilistImportContext({
    accessToken,
    authFailureUserId: account?.userId,
  });

  const mutation = buildUpdateFavouriteOrderMutation(form.favouriteType, payload);
  const response = await ctx.executeQuery<UpdateFavouriteOrderResponse>(
    mutation.query,
    mutation.variables,
  );

  if (!response?.UpdateFavouriteOrder) {
    throw new Error('AniList did not confirm the favourite order update.');
  }

  await patchFavouriteSortOrderInCache(anilistUserId, form.favouriteType, orderedIds);
}

export async function unfavouriteItems(
  form: ReorderFavouritesForm,
  anilistUserId: number,
  entityIds: readonly number[],
  signal?: AbortSignal,
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }

  signal?.throwIfAborted();
  const username = form.username.trim();
  const account = findAnilistAccountByName(username);
  const accessToken = requireAccessTokenForUsername(username);
  const ctx = makeAnilistImportContext({
    accessToken,
    authFailureUserId: account?.userId,
  });

  for (const entityId of entityIds) {
    signal?.throwIfAborted();
    const mutation = buildToggleFavouriteMutation(form.favouriteType, entityId);
    const response = await ctx.executeQuery<ToggleFavouriteResponse>(
      mutation.query,
      mutation.variables,
    );
    if (!response?.ToggleFavourite) {
      throw new Error(`AniList did not unfavourite id ${entityId}.`);
    }
  }

  await removeFavouritesFromCache(anilistUserId, form.favouriteType, entityIds);
}
