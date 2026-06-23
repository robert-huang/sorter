import type { Item } from '../../types';
import type { AnilistMediaFormat } from './types';
import type { AnilistItemLabelSource } from '../../types';
import { formatMediaDisplayLabel, type MediaTitleFields } from './mediaDisplayLabel';
import { pickCharacterName, pickPersonName } from './personDisplayLabel';

export function resolveAnilistItemLabel(
  source: AnilistItemLabelSource,
  includeFormatInLabel: boolean,
): string {
  if (source.kind === 'media') {
    return formatMediaDisplayLabel(
      source.titleFields,
      source.format,
      includeFormatInLabel,
    );
  }
  if (source.kind === 'character') {
    return pickCharacterName(source.nameFields, undefined, source.fallbackLabel);
  }
  return pickPersonName(source.nameFields, undefined, source.fallbackLabel);
}

export function itemMatchesSearch(item: Item, needle: string): boolean {
  if (!needle) {
    return true;
  }
  if (item.searchTokens?.some((token) => token.toLowerCase().includes(needle))) {
    return true;
  }
  return item.label.toLowerCase().includes(needle);
}

export function relabelAnilistItem(
  item: Item,
  includeFormatInLabel: boolean,
): Item {
  if (!item.anilistLabelSource) {
    return item;
  }
  const label = resolveAnilistItemLabel(
    item.anilistLabelSource,
    includeFormatInLabel,
  );
  // Preserve referential identity when nothing changed so callers can
  // cheaply detect no-ops (avoids needless re-renders / autosave churn).
  return label === item.label ? item : { ...item, label };
}

/**
 * Relabel an AniList item to the current display preferences while
 * preserving whether its previous label carried a `(FORMAT)` suffix.
 *
 * Engine / staged items don't track the user's "include format" toggle,
 * so we infer it from the existing label: a media label that ends with
 * ` (TV)` etc. was built with the suffix on. This lets a language switch
 * relabel already-staged or in-progress items without flipping the
 * format-suffix choice the user made at stage time.
 */
export function relabelAnilistItemPreservingFormat(item: Item): Item {
  const source = item.anilistLabelSource;
  if (!source) {
    return item;
  }
  const includeFormat =
    source.kind === 'media' && source.format
      ? item.label.endsWith(` (${source.format})`)
      : false;
  return relabelAnilistItem(item, includeFormat);
}

export function mediaLabelSourceFromRow(
  row: MediaTitleFields & { format: AnilistMediaFormat | null },
): AnilistItemLabelSource {
  return {
    kind: 'media',
    titleFields: {
      id: row.id,
      title_romaji: row.title_romaji,
      title_english: row.title_english,
      title_native: row.title_native,
    },
    format: row.format,
  };
}
