import type { AnilistItemLabelSource, Item } from '../../types';
import {
  isCustomAnilistItemLabel,
  relabelAnilistItem,
  relabelAnilistItemPreservingFormat,
  resolveCachedAnilistMediaItem,
} from './anilistItemLabel';
import {
  characterNameSearchParts,
  personNameSearchParts,
} from './personDisplayLabel';
import { productionReads } from './readQueries';

const ANILIST_STUDIO_ID_PREFIX = 'anilist-studios:';
const QUERY_CHUNK_SIZE = 500;

export type AnilistItemHydrationEntry = {
  item: Item;
  /** Saved slots may predate persisted custom-label tracking. */
  inferLegacyCustomLabel?: boolean;
};

export function anilistStudioExternalId(item: Item): number | null {
  if (!item.id.startsWith(ANILIST_STUDIO_ID_PREFIX)) {
    return null;
  }
  const externalId = Number(item.id.slice(ANILIST_STUDIO_ID_PREFIX.length));
  return Number.isSafeInteger(externalId) && externalId > 0 ? externalId : null;
}

export function needsAnilistItemHydration(item: Item): boolean {
  return canRefreshAnilistItem(item) && !item.anilistLabelSource;
}

/** AniList identity is stable; cached metadata for it may change. */
export function canRefreshAnilistItem(item: Item): boolean {
  return (
    item.source?.kind === 'anilist' ||
    item.source?.kind === 'anilist-character' ||
    item.source?.kind === 'anilist-staff' ||
    anilistStudioExternalId(item) != null
  );
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sameHydratedMetadata(left: Item, right: Item): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.url === right.url &&
    left.imageUrl === right.imageUrl &&
    left.anilistImageSource === right.anilistImageSource &&
    left.source === right.source &&
    sameStringArray(left.searchTokens, right.searchTokens) &&
    JSON.stringify(left.anilistLabelSource) ===
      JSON.stringify(right.anilistLabelSource) &&
    left.anilistLabelMode === right.anilistLabelMode &&
    left.anilistLabelIncludesFormat === right.anilistLabelIncludesFormat
  );
}

function automaticLabelIncludedFormat(item: Item): boolean | undefined {
  if (item.anilistLabelIncludesFormat !== undefined) {
    return item.anilistLabelIncludesFormat;
  }
  const source = item.anilistLabelSource;
  return source?.kind === 'media' && source.format != null
    ? item.label.endsWith(` (${source.format})`)
    : undefined;
}

function isAnilistCdnImageUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).hostname === 's4.anilist.co';
  } catch {
    return false;
  }
}

function refreshSourceImage(item: Item, sourceImage: string | null): Item {
  if (!sourceImage) {
    return item;
  }
  const usesSourceImage =
    item.anilistImageSource !== undefined
      ? item.imageUrl === item.anilistImageSource
      : item.imageUrl == null || isAnilistCdnImageUrl(item.imageUrl);
  return {
    ...item,
    ...(usesSourceImage ? { imageUrl: sourceImage } : {}),
    anilistImageSource: sourceImage,
  };
}

function finishSourceHydration<T extends AnilistItemHydrationEntry>(
  entry: T,
  resolved: Item,
): T {
  const original = entry.item;
  let preserveCustomLabel = original.anilistLabelMode === 'custom';
  if (
    !preserveCustomLabel &&
    original.anilistLabelMode !== 'automatic' &&
    original.anilistLabelSource
  ) {
    preserveCustomLabel = isCustomAnilistItemLabel(original);
  }
  if (
    !preserveCustomLabel &&
    entry.inferLegacyCustomLabel &&
    !original.anilistLabelSource
  ) {
    preserveCustomLabel = isCustomAnilistItemLabel({
      ...resolved,
      label: original.label,
    });
  }

  const resolvedSource = resolved.anilistLabelSource;
  const includesFormat =
    automaticLabelIncludedFormat(original) ??
    (resolvedSource?.kind === 'media' && resolvedSource.format != null
      ? original.label.endsWith(` (${resolvedSource.format})`)
      : undefined);
  let next: Item;
  if (preserveCustomLabel) {
    next = {
      ...resolved,
      label: original.label,
      anilistLabelMode: 'custom',
      ...(includesFormat === undefined
        ? {}
        : { anilistLabelIncludesFormat: includesFormat }),
    };
  } else if (resolvedSource?.kind === 'media') {
    next = relabelAnilistItem(resolved, includesFormat ?? false, true);
  } else {
    next = relabelAnilistItemPreservingFormat(resolved, true);
  }
  return {
    ...entry,
    item: sameHydratedMetadata(original, next) ? original : next,
  };
}

function hydratePersonEntry<T extends AnilistItemHydrationEntry>(
  entry: T,
  row: {
    id: number;
    name_full: string | null;
    name_native: string | null;
    name_alternatives_json?: string | null;
    name_alternatives_spoiler_json?: string | null;
    image?: string | null;
  },
  kind: 'character' | 'person',
): T {
  const nameFields = {
    id: row.id,
    name_full: row.name_full,
    name_native: row.name_native,
  };
  const anilistLabelSource: AnilistItemLabelSource = {
    kind,
    nameFields,
    fallbackLabel: kind === 'character' ? 'Character' : 'Staff',
  };
  const resolved: Item = {
    ...entry.item,
    anilistLabelSource,
    searchTokens:
      kind === 'character'
        ? characterNameSearchParts(row)
        : personNameSearchParts(nameFields),
  };
  return finishSourceHydration(
    entry,
    refreshSourceImage(resolved, row.image ?? null),
  );
}

async function readRowsInChunks<T>(
  ids: readonly number[],
  read: (chunk: readonly number[]) => Promise<T[]>,
): Promise<T[]> {
  const uniqueIds = [...new Set(ids)];
  const reads: Array<Promise<T[]>> = [];
  for (let index = 0; index < uniqueIds.length; index += QUERY_CHUNK_SIZE) {
    reads.push(read(uniqueIds.slice(index, index + QUERY_CHUNK_SIZE)));
  }
  return (await Promise.all(reads)).flat();
}

/** Refresh cached title/name metadata while preserving user-owned fields. */
export async function hydrateAnilistItemEntries<
  T extends AnilistItemHydrationEntry,
>(entries: readonly T[]): Promise<T[]> {
  const mediaIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist'
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const characterIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-character'
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const staffIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-staff'
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const studioIds = entries
    .map(({ item }) => anilistStudioExternalId(item))
    .filter((id): id is number => id != null);
  if (
    mediaIds.length === 0 &&
    characterIds.length === 0 &&
    staffIds.length === 0 &&
    studioIds.length === 0
  ) {
    return [...entries];
  }

  try {
    const [mediaRows, characterRows, staffRows, studioRows] = await Promise.all([
      readRowsInChunks(mediaIds, (ids) => productionReads.getMediaByIds(ids)),
      readRowsInChunks(characterIds, (ids) =>
        productionReads.getCharactersByIds(ids),
      ),
      readRowsInChunks(staffIds, (ids) => productionReads.getStaffByIds(ids)),
      readRowsInChunks(studioIds, (ids) =>
        productionReads.getStudiosByIds(ids),
      ),
    ]);
    const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
    const charactersById = new Map(
      characterRows.map((row) => [row.id, row]),
    );
    const staffById = new Map(staffRows.map((row) => [row.id, row]));
    const studiosById = new Map(studioRows.map((row) => [row.id, row]));
    return entries.map((entry) => {
      const studioId = anilistStudioExternalId(entry.item);
      if (studioId != null) {
        const row = studiosById.get(studioId);
        return row
          ? finishSourceHydration(entry, {
              ...entry.item,
              anilistLabelSource: { kind: 'studio', label: row.name },
              searchTokens: [row.name],
            })
          : entry;
      }
      const source = entry.item.source;
      if (!source) return entry;
      if (source.kind === 'anilist') {
        const row = mediaById.get(source.externalId);
        if (!row) return entry;
        const resolved = resolveCachedAnilistMediaItem(entry.item, row);
        return finishSourceHydration(
          entry,
          refreshSourceImage(resolved, row.cover_image),
        );
      }
      if (source.kind === 'anilist-character') {
        const row = charactersById.get(source.externalId);
        return row ? hydratePersonEntry(entry, row, 'character') : entry;
      }
      if (source.kind === 'anilist-staff') {
        const row = staffById.get(source.externalId);
        return row ? hydratePersonEntry(entry, row, 'person') : entry;
      }
      return entry;
    });
  } catch {
    // Cached source metadata is optional; retain the denormalized labels.
    return [...entries];
  }
}

/** Refresh a loaded slot's item dictionary without rebuilding it on a no-op. */
export async function hydrateAnilistItemRecord(
  items: Record<string, Item>,
): Promise<Record<string, Item>> {
  const records = Object.entries(items);
  const hydrated = await hydrateAnilistItemEntries(
    records.map(([key, item]) => ({
      key,
      item,
      inferLegacyCustomLabel:
        !item.anilistLabelSource &&
        canRefreshAnilistItem(item) &&
        item.anilistLabelMode !== 'automatic',
    })),
  );
  let changed = false;
  const next: Record<string, Item> = {};
  for (const entry of hydrated) {
    const original = items[entry.key]!;
    if (entry.item !== original) {
      changed = true;
    }
    next[entry.key] = entry.item;
  }
  return changed ? next : items;
}
