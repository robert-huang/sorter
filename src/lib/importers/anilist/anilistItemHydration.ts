import type { AnilistItemLabelSource, Item } from '../../types';
import {
  isCustomAnilistItemLabel,
  relabelAnilistItemPreservingFormat,
  resolveCachedAnilistMediaItem,
} from './anilistItemLabel';
import { personNameSearchParts } from './personDisplayLabel';
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
  if (item.anilistLabelSource) {
    return false;
  }
  return (
    item.source?.kind === 'anilist' ||
    item.source?.kind === 'anilist-character' ||
    item.source?.kind === 'anilist-staff' ||
    anilistStudioExternalId(item) != null
  );
}

function finishSourceHydration<T extends AnilistItemHydrationEntry>(
  entry: T,
  resolved: Item,
): T {
  if (!entry.inferLegacyCustomLabel) {
    return {
      ...entry,
      item:
        resolved.anilistLabelMode === 'custom'
          ? resolved
          : relabelAnilistItemPreservingFormat(resolved, true),
    };
  }

  const candidate = { ...resolved, label: entry.item.label };
  if (isCustomAnilistItemLabel(candidate)) {
    const source = candidate.anilistLabelSource;
    const includesFormat =
      candidate.anilistLabelIncludesFormat ??
      (source?.kind === 'media' && source.format != null
        ? candidate.label.endsWith(` (${source.format})`)
        : undefined);
    return {
      ...entry,
      item: {
        ...candidate,
        anilistLabelMode: 'custom',
        ...(includesFormat === undefined
          ? {}
          : { anilistLabelIncludesFormat: includesFormat }),
      },
    };
  }
  return {
    ...entry,
    item: relabelAnilistItemPreservingFormat(candidate, true),
  };
}

function hydratePersonEntry<T extends AnilistItemHydrationEntry>(
  entry: T,
  row: { id: number; name_full: string | null; name_native: string | null },
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
  return finishSourceHydration(entry, {
    ...entry.item,
    anilistLabelSource,
    searchTokens: personNameSearchParts(nameFields),
  });
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

/** Attach cached title/name metadata while preserving legacy manual labels. */
export async function hydrateAnilistItemEntries<
  T extends AnilistItemHydrationEntry,
>(entries: readonly T[]): Promise<T[]> {
  const mediaIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const characterIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-character' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const staffIds = entries
    .map(({ item }) =>
      item.source?.kind === 'anilist-staff' && !item.anilistLabelSource
        ? item.source.externalId
        : null,
    )
    .filter((id): id is number => id != null);
  const studioIds = entries
    .map(({ item }) =>
      !item.anilistLabelSource ? anilistStudioExternalId(item) : null,
    )
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
      if (entry.item.anilistLabelSource) {
        return entry;
      }
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
        return finishSourceHydration(entry, {
          ...resolved,
          imageUrl: resolved.imageUrl ?? row.cover_image ?? undefined,
        });
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

/** Repair a loaded slot's item dictionary without rebuilding it on a no-op. */
export async function hydrateAnilistItemRecord(
  items: Record<string, Item>,
): Promise<Record<string, Item>> {
  const records = Object.entries(items);
  const hydrated = await hydrateAnilistItemEntries(
    records.map(([key, item]) => ({
      key,
      item,
      inferLegacyCustomLabel:
        needsAnilistItemHydration(item) &&
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
