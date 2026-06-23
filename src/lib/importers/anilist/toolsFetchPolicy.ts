import { isGraphTimestampStale } from './graphConstants';

/** Shared fetch options for Tools panels (DB-first + live API fallback). */
export type ToolsFetchOptions = {
  /** Right-click / explicit bust — always re-fetch from AniList. */
  forceRefresh?: boolean;
};

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
