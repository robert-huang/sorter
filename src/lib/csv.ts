import Papa from 'papaparse';
import type { DedupWarning, Item, ItemId } from './types';

// ---------- canonical key ----------

/**
 * Slug a label down to a stable canonical key for dedup + id purposes.
 *
 * Steps:
 *  1. NFKC-normalize so full-width Latin (`ＣＬＡＮＮＡＤ` → `CLANNAD`),
 *     half/full-width katakana, decomposed accents (`é` as `e + ◌́`), and
 *     full-width punctuation (`？` → `?`, `～` → `~`) collapse to a
 *     single canonical form before we slug them.
 *  2. trim, lowercase (locale-aware so `İ` folds correctly for non-ASCII
 *     scripts).
 *  3. Replace each NON-letter / non-number Unicode codepoint with `-`.
 *     We deliberately do NOT collapse runs of non-letter chars into a
 *     single `-` — preserving the count means two titles that differ
 *     only by an extra punctuation character produce distinct ids
 *     (`かぐや様...～...～` vs `かぐや様...？～...～` → S1 vs S2 of
 *     Kaguya-sama dedup correctly instead of colliding on a single
 *     `-`). Trade-off: trivial whitespace differences like `"Foo Bar"`
 *     vs `"Foo  Bar"` now produce different ids (`foo-bar` vs
 *     `foo--bar`) — acceptable for CSV data where repeated whitespace
 *     is rare.
 *  4. Strip any run of `-` at the start or end. Trailing punctuation
 *     like `!!` still gets folded off cleanly.
 *  5. Empty result falls back to `'item'`.
 */
export function canonicalKey(label: string): ItemId {
  const slug = label
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}

// ---------- header detection (advisory only; UI defaults the checkbox to OFF) ----------

const COL1_HEADERS = new Set(['item', 'label', 'name', 'title']);
const COL2_HEADERS = new Set(['', 'url', 'link', 'href']);
const COL3_HEADERS = new Set([
  '',
  'image',
  'img',
  'picture',
  'imageurl',
  'image_url',
  'image url',
]);

/**
 * Returns true if the first row looks header-like by our strict rule (all
 * present columns must match). Used to display a soft hint next to the
 * "First row is a header" checkbox.
 */
export function looksLikeHeader(firstRow: string[]): boolean {
  if (firstRow.length === 0) return false;
  const c1 = (firstRow[0] ?? '').trim().toLowerCase();
  if (!COL1_HEADERS.has(c1)) return false;
  if (firstRow.length > 1) {
    const c2 = (firstRow[1] ?? '').trim().toLowerCase();
    if (!COL2_HEADERS.has(c2)) return false;
  }
  if (firstRow.length > 2) {
    const c3 = (firstRow[2] ?? '').trim().toLowerCase();
    if (!COL3_HEADERS.has(c3)) return false;
  }
  return true;
}

// ---------- parsing ----------

export interface RawRow {
  label: string;
  url?: string;
  imageUrl?: string;
  sourceName: string;
  sourceRow: number; // 1-indexed within source, AFTER header skip
  /**
   * Optional explicit id override. When set, `dedupRows` uses this
   * value instead of `canonicalKey(label)` to identify the row. Used
   * by the START tab's edit-overlay to let the user disambiguate two
   * different labels that happen to slug to the same id (or to rename
   * a row's logical id without touching its display label). When
   * unset, dedup behavior is unchanged.
   */
  idOverride?: ItemId;
}

export interface ParseResult {
  items: Item[]; // deduped within this source
  warnings: DedupWarning[];
  detectedHeader: boolean; // result of `looksLikeHeader` on the parsed first row
}

/**
 * Parse a single CSV text into RawRows. Returns the rows BEFORE dedup so
 * dedup can be done in a unified pass across multiple sources.
 */
export function parseCsvRows(
  text: string,
  sourceName: string,
  skipHeader: boolean,
): { rows: RawRow[]; detectedHeader: boolean } {
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
  });
  const allRows = (parsed.data ?? []).filter(
    (r) => Array.isArray(r) && r.some((cell) => (cell ?? '').trim() !== ''),
  );
  if (allRows.length === 0) {
    return { rows: [], detectedHeader: false };
  }
  const detected = looksLikeHeader(allRows[0]);
  const dataRows = skipHeader ? allRows.slice(1) : allRows;
  const rows: RawRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const label = (row[0] ?? '').trim();
    if (!label) continue;
    const url = ((row[1] ?? '').trim() || undefined) as string | undefined;
    const imageUrl = ((row[2] ?? '').trim() || undefined) as string | undefined;
    rows.push({
      label,
      url,
      imageUrl,
      sourceName,
      sourceRow: i + 1,
    });
  }
  return { rows, detectedHeader: detected };
}

/**
 * Parse plain-text "extras" — one label per line, no commas. Returns RawRows
 * with sourceName 'extras'. Used for the unranked-singletons textarea on the
 * START tab.
 */
export function parseExtrasText(text: string, sourceName = 'extras'): RawRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((label, i) => ({
    label,
    sourceName,
    sourceRow: i + 1,
  }));
}

/**
 * Dedup a flat list of RawRows. First occurrence wins for position; later
 * occurrences fill in missing URL/IMAGE on the first.
 *
 * Returns deduped items AND a list of warnings, one per canonical key that
 * had more than one occurrence.
 */
export function dedupRows(rows: RawRow[]): {
  items: Item[];
  warnings: DedupWarning[];
} {
  const byKey = new Map<
    ItemId,
    {
      item: Item;
      occurrences: RawRow[];
      mergedUrlFrom?: string;
      mergedImageFrom?: string;
    }
  >();

  for (const row of rows) {
    const id = row.idOverride ?? canonicalKey(row.label);
    const existing = byKey.get(id);
    if (!existing) {
      byKey.set(id, {
        item: {
          id,
          label: row.label,
          url: row.url,
          imageUrl: row.imageUrl,
        },
        occurrences: [row],
      });
      continue;
    }
    existing.occurrences.push(row);
    if (!existing.item.url && row.url) {
      existing.item = { ...existing.item, url: row.url };
      existing.mergedUrlFrom = row.sourceName;
    }
    if (!existing.item.imageUrl && row.imageUrl) {
      existing.item = { ...existing.item, imageUrl: row.imageUrl };
      existing.mergedImageFrom = row.sourceName;
    }
  }

  const items: Item[] = [];
  const warnings: DedupWarning[] = [];
  for (const entry of byKey.values()) {
    items.push(entry.item);
    if (entry.occurrences.length <= 1) continue;
    const first = entry.occurrences[0];
    const sources = new Set(entry.occurrences.map((o) => o.sourceName));
    warnings.push({
      canonicalKey: entry.item.id,
      displayLabel: entry.item.label,
      occurrences: entry.occurrences.map((o) => ({
        sourceName: o.sourceName,
        rowNumber: o.sourceRow,
        hadUrl: !!o.url,
        hadImage: !!o.imageUrl,
      })),
      winningSource: first.sourceName,
      winningRow: first.sourceRow,
      mergedFromSources: {
        url: entry.mergedUrlFrom,
        image: entry.mergedImageFrom,
      },
      reason: sources.size > 1 ? 'duplicate-across-sources' : 'duplicate-in-source',
    });
  }
  return { items, warnings };
}

// ---------- high-level entry points ----------

export interface SourceParse {
  sourceName: string;
  /** Raw rows BEFORE the cross-source dedup pass. */
  rawRows: RawRow[];
  detectedHeader: boolean;
}

/**
 * One row in the per-source preview list. We keep the originating
 * `sourceRow` alongside the deduped Item so the START-tab Edit
 * button can open the EditItemModal against the correct RawRow even
 * for rows that are NOT in any dedup warning. `sourceRow` is the
 * 1-indexed row number (post-header-skip) of the FIRST occurrence of
 * this id within the source.
 */
export interface PreviewItem {
  item: Item;
  sourceRow: number;
}

/**
 * Per-source-then-global parse. Each source contributes its rawRows; we then
 * dedup across all sources in input order (so the first source has placement
 * priority).
 */
export function parseSources(sources: SourceParse[]): {
  items: Item[];
  warnings: DedupWarning[];
  perSource: Array<{
    sourceName: string;
    items: PreviewItem[]; // ordered, deduped within this source's own rows
  }>;
} {
  const perSource: Array<{ sourceName: string; items: PreviewItem[] }> = [];
  const flat: RawRow[] = [];
  for (const s of sources) {
    flat.push(...s.rawRows);
    // Pre-compute per-source deduped item list (in the original row order)
    // so the preview shows what we'd produce for that file alone.
    const seen = new Set<ItemId>();
    const localItems: PreviewItem[] = [];
    for (const r of s.rawRows) {
      const id = r.idOverride ?? canonicalKey(r.label);
      if (seen.has(id)) continue;
      seen.add(id);
      localItems.push({
        item: {
          id,
          label: r.label,
          url: r.url,
          imageUrl: r.imageUrl,
        },
        sourceRow: r.sourceRow,
      });
    }
    perSource.push({ sourceName: s.sourceName, items: localItems });
  }
  const { items, warnings } = dedupRows(flat);
  return { items, warnings, perSource };
}

/**
 * Convenience helper: dedup-merge two sets of items, returning the merged
 * items dict in the order of `a` then any net-new items from `b`. Used by
 * mid-sort appendPreRankedSublist (caller still owns the queue insertion).
 *
 * Items in `b` whose id matches an item in `a` are dropped (caller can read
 * `skipped` to know which ones); URL/IMAGE on the corresponding `a` item is
 * filled in if missing.
 */
export function mergeIntoExisting(
  existing: Record<ItemId, Item>,
  newItems: Item[],
): {
  mergedDict: Record<ItemId, Item>;
  netNew: Item[];
  skipped: Item[];
  metadataFills: Array<{ id: ItemId; field: 'url' | 'imageUrl' }>;
} {
  const mergedDict = { ...existing };
  const netNew: Item[] = [];
  const skipped: Item[] = [];
  const metadataFills: Array<{ id: ItemId; field: 'url' | 'imageUrl' }> = [];
  for (const it of newItems) {
    const ex = mergedDict[it.id];
    if (!ex) {
      mergedDict[it.id] = it;
      netNew.push(it);
      continue;
    }
    skipped.push(it);
    let updated = ex;
    if (!ex.url && it.url) {
      updated = { ...updated, url: it.url };
      metadataFills.push({ id: it.id, field: 'url' });
    }
    if (!ex.imageUrl && it.imageUrl) {
      updated = { ...updated, imageUrl: it.imageUrl };
      metadataFills.push({ id: it.id, field: 'imageUrl' });
    }
    mergedDict[it.id] = updated;
  }
  return { mergedDict, netNew, skipped, metadataFills };
}
