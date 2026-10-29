import type { Item, ItemId, SortVersion, SortVersionItem } from './types';

// Kept free of storage/engine imports so storage.ts and slotResultsImport.ts can use it without an import cycle.

export function newSortVersionId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function sortVersionItem(item: Pick<Item, 'label' | 'imageUrl' | 'url'>): SortVersionItem {
  const out: SortVersionItem = { label: item.label };
  if (item.imageUrl) out.imageUrl = item.imageUrl;
  if (item.url) out.url = item.url;
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local date, e.g. "2026-10-28", or "2026-10-28 14:05" with `withTime`. */
export function formatSortVersionDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersion(raw: unknown): SortVersion | null {
  if (!isRecord(raw)) return null;
  const { id, createdAt, rankedIds, items } = raw;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (!Array.isArray(rankedIds) || !isRecord(items)) return null;
  const ids = rankedIds.filter((v): v is string => typeof v === 'string' && isRecord(items[v]));
  if (ids.length === 0) return null;
  // Keep the stored key order: autosaveBlobsEqual compares blobs as JSON strings.
  const ranked = new Set(ids);
  const cleanItems: Record<ItemId, SortVersionItem> = {};
  for (const itemId of Object.keys(items).filter((key) => ranked.has(key))) {
    const it = items[itemId] as Record<string, unknown>;
    cleanItems[itemId] = sortVersionItem({
      label: typeof it.label === 'string' ? it.label : itemId,
      imageUrl: typeof it.imageUrl === 'string' ? it.imageUrl : undefined,
      url: typeof it.url === 'string' ? it.url : undefined,
    });
  }
  return {
    id: typeof id === 'string' && id ? id : newSortVersionId(),
    createdAt,
    rankedIds: ids,
    items: cleanItems,
    ...(raw.live === true ? { live: true as const } : {}),
  };
}

/** Freezes every version but the newest, which keeps its `live` flag if it had one. */
export function onlyNewestLive(versions: SortVersion[]): SortVersion[] {
  return versions.map((v, i) => {
    if (!v.live || i === versions.length - 1) return v;
    return frozenVersion(v);
  });
}

export function frozenVersion(v: SortVersion): SortVersion {
  if (!v.live) return v;
  const { live: _live, ...frozen } = v;
  return frozen;
}

/** Malformed entries are dropped; returns undefined when nothing valid remains. */
export function normalizeSortVersions(raw: unknown): SortVersion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(normalizeVersion).filter((v): v is SortVersion => v !== null);
  return out.length > 0 ? onlyNewestLive(out) : undefined;
}
