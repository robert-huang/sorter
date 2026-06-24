import { isGraphTimestampStale } from './graphConstants';

/** Shared fetch options for Tools panels (DB-first + live API fallback). */
export type ToolsFetchOptions = {
  /** Right-click / explicit bust — always re-fetch from AniList. */
  forceRefresh?: boolean;
};

/** Favourites tool — scoped refresh / expansion modes. */
export type FavouritesFetchOptions = {
  /** Right-click Analyze — re-import favourite chars/staff only. */
  forceRefreshFavourites?: boolean;
  /** Expand Roles — full graph expansion into SQLite before building the report. */
  expandRoles?: boolean;
};

export function favouritesImportOptions(
  options?: FavouritesFetchOptions,
): ToolsFetchOptions | undefined {
  if (options?.forceRefreshFavourites) {
    return { forceRefresh: true };
  }
  return undefined;
}

export function favouritesGraphForceOptions(
  options?: FavouritesFetchOptions,
): ToolsFetchOptions | undefined {
  if (options?.expandRoles) {
    return { forceRefresh: true };
  }
  return undefined;
}

/**
 * Whether graph-backed data (cast, staff filmography, user list) should
 * be pulled from AniList before reading the local DB.
 *
 * Normal run: missing or >90d stale timestamps trigger refresh (matches
 * py CLI; differs from A2A which serves stale until explicit refresh).
 */
export function needsGraphDataRefresh(
  fetchedAt: number | null,
  options?: ToolsFetchOptions,
): boolean {
  if (options?.forceRefresh) {
    return true;
  }
  if (fetchedAt === null) {
    return true;
  }
  return isGraphTimestampStale(fetchedAt);
}
