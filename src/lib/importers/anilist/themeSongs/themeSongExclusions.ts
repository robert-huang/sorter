import { themeSongRowKey } from './themeSongRowKey';
import type { MediaThemeSongRow } from './types';

export function applyThemeSongExclusions(
  rows: readonly MediaThemeSongRow[],
  excludedRowKeys: readonly string[],
): MediaThemeSongRow[] {
  if (excludedRowKeys.length === 0) {
    return [...rows];
  }
  const excluded = new Set(excludedRowKeys);
  return rows.filter((row) => !excluded.has(themeSongRowKey(row)));
}

export function mergeExcludedRowKeys(
  existing: readonly string[] | undefined,
  added: string,
): string[] {
  const set = new Set(existing ?? []);
  set.add(added);
  return [...set];
}
