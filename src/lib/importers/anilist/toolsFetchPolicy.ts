/** Shared fetch options for Tools panels (DB-first + live API fallback). */
export type ToolsFetchOptions = {
  /** Right-click / explicit bust — always re-fetch from AniList. */
  forceRefresh?: boolean;
  /** When aborted, in-flight list import / live fetches stop between chunks. */
  signal?: AbortSignal;
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
 * Whether graph-backed data should be pulled from AniList before reading
 * the local DB on a normal (non-force) tool run.
 *
 * Only missing expansion (`fetchedAt === null`) triggers auto-refresh.
 * Age-based staleness (>90d) is surfaced in the UI; refresh via ↻ username,
 * media/staff modals, or explicit force-refresh on the tool.
 */
export function needsGraphDataRefresh(
  fetchedAt: number | null,
  options?: ToolsFetchOptions,
): boolean {
  if (options?.forceRefresh) {
    return true;
  }
  return fetchedAt === null;
}
