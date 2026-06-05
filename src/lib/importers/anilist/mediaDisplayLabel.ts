import type { AnilistMediaFormat } from './types';
import {
  getMediaTitleDisplayMode,
  type MediaTitleDisplayMode,
} from './displayPreferences';

export type MediaTitleFields = {
  title_romaji: string | null;
  title_english: string | null;
  title_native: string | null;
  id: number;
};

export type MediaSearchFields = MediaTitleFields & {
  synonyms_json?: string | null;
};

function untitledMediaLabel(id: number): string {
  return `Untitled (${id})`;
}

/**
 * Display title for media — mode from preferences unless overridden.
 *
 * Per-mode waterfall (preferred title first, then the most broadly
 * readable fallbacks):
 *   - native:  native  → english → romaji
 *   - english: english → romaji  → native
 *   - romaji:  romaji  → english → native
 *
 * `fallback` overrides the final `Untitled (id)` placeholder — used by
 * the detail modal so a still-loading row keeps the clicked label.
 */
export function pickMediaTitle(
  fields: MediaTitleFields,
  mode: MediaTitleDisplayMode = getMediaTitleDisplayMode(),
  fallback?: string,
): string {
  const last = fallback ?? untitledMediaLabel(fields.id);
  if (mode === 'native') {
    return (
      fields.title_native ?? fields.title_english ?? fields.title_romaji ?? last
    );
  }
  if (mode === 'romaji') {
    return (
      fields.title_romaji ?? fields.title_english ?? fields.title_native ?? last
    );
  }
  return fields.title_english ?? fields.title_romaji ?? fields.title_native ?? last;
}

/** All stored title strings for substring search (display mode independent). */
export function mediaTitleSearchParts(fields: MediaSearchFields): readonly string[] {
  const parts: string[] = [];
  for (const value of [
    fields.title_romaji,
    fields.title_english,
    fields.title_native,
  ]) {
    if (value && !parts.includes(value)) {
      parts.push(value);
    }
  }

  if (fields.synonyms_json) {
    try {
      const parsed = JSON.parse(fields.synonyms_json) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'string' && entry && !parts.includes(entry)) {
            parts.push(entry);
          }
        }
      }
    } catch {
      /* ignore malformed synonyms_json */
    }
  }

  return parts;
}

/**
 * When `includeFormat` is on, labels become `Title (FORMAT)` — e.g.
 * `Shinryaku! Ika Musume (TV)` or `Sakurada Reset (NOVEL)`.
 */
export function formatMediaDisplayLabel(
  fields: MediaTitleFields,
  format: AnilistMediaFormat | null | undefined,
  includeFormat: boolean,
  mode?: MediaTitleDisplayMode,
): string {
  const title = pickMediaTitle(fields, mode);
  if (!includeFormat || !format) {
    return title;
  }
  return `${title} (${format})`;
}
