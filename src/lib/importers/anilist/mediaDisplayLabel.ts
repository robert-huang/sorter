import type { AnilistMediaFormat } from './types';

export type MediaTitleFields = {
  title_romaji: string | null;
  title_english: string | null;
  title_native: string | null;
  id: number;
};

/** Romaji-first display title (falls back through english → native). */
export function pickMediaTitle(fields: MediaTitleFields): string {
  return (
    fields.title_romaji ??
    fields.title_english ??
    fields.title_native ??
    `Untitled (${fields.id})`
  );
}

/**
 * When `includeFormat` is on, labels become `Title (FORMAT)` — e.g.
 * `Shinryaku! Ika Musume (TV)` or `Sakurada Reset (NOVEL)`.
 */
export function formatMediaDisplayLabel(
  fields: MediaTitleFields,
  format: AnilistMediaFormat | null | undefined,
  includeFormat: boolean,
): string {
  const title = pickMediaTitle(fields);
  if (!includeFormat || !format) return title;
  return `${title} (${format})`;
}
