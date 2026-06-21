import Papa from 'papaparse';
import type { CommaInLabelWarning, DedupWarning, ExtraColumnsWarning, Item, ItemId } from './types';

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

/**
 * PapaParse defaults to delimiter auto-detection. On title-only lines with
 * semicolons but no commas (e.g. `Steins;Gate (TV)`), it picks `;` as the
 * delimiter and splits the title into multiple cells. Our comma-in-label
 * repair then rejoins those with `, ` — corrupting the label. This app
 * only supports comma-separated columns (ITEM, URL, IMAGE), so pin it.
 */
export const PAPA_COMMA_CSV_OPTIONS = {
  skipEmptyLines: 'greedy' as const,
  delimiter: ',',
};

/**
 * True when `cell` looks like a URL column value (http(s) or bare domain
 * with a path). Used to distinguish real CSV url/image columns from title
 * fragments split on unquoted commas.
 */
export function looksLikeUrl(cell: string): boolean {
  const t = cell.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  // Bare domain + path, e.g. anilist.co/anime/123 or example.com/foo
  return /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t);
}

interface NaiveCsvFields {
  label: string;
  url?: string;
  imageUrl?: string;
}

/** First-three-slot mapping before comma-in-label repair. */
function naiveCsvFieldsFromRow(row: string[]): NaiveCsvFields {
  const label = (row[0] ?? '').trim();
  const url = ((row[1] ?? '').trim() || undefined) as string | undefined;
  const imageUrl = ((row[2] ?? '').trim() || undefined) as string | undefined;
  return { label, url, imageUrl };
}

export interface CommaInLabelRepair {
  label: string;
  url?: string;
  imageUrl?: string;
  repaired: boolean;
  naiveParsedAs: NaiveCsvFields;
  joinedCellCount: number;
}

/**
 * When commas split a line into multiple cells but no trailing cell looks
 * like a URL, join all non-empty cells into one label.
 */
export function repairCommaSplitRow(row: string[]): CommaInLabelRepair {
  const naiveParsedAs = naiveCsvFieldsFromRow(row);
  const cells = row.map((c) => (c ?? '').trim()).filter((c) => c !== '');
  if (cells.length <= 1) {
    return {
      label: naiveParsedAs.label,
      url: naiveParsedAs.url,
      imageUrl: naiveParsedAs.imageUrl,
      repaired: false,
      naiveParsedAs,
      joinedCellCount: cells.length,
    };
  }
  const trailing = cells.slice(1);
  if (trailing.some(looksLikeUrl)) {
    return {
      label: naiveParsedAs.label,
      url: naiveParsedAs.url,
      imageUrl: naiveParsedAs.imageUrl,
      repaired: false,
      naiveParsedAs,
      joinedCellCount: cells.length,
    };
  }
  return {
    label: cells.join(', '),
    url: undefined,
    imageUrl: undefined,
    repaired: true,
    naiveParsedAs,
    joinedCellCount: cells.length,
  };
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
  /**
   * Full parsed cell list, attached only when this row had MORE than
   * the expected 3 non-empty cells (i.e. an `ExtraColumnsWarning`
   * was emitted for it). Lets `EditItemModal` render the original
   * verbatim row so the user can manually copy substrings into the
   * label/url/image fields when an unquoted comma broke the parse.
   *
   * Also attached when a `CommaInLabelWarning` was emitted (auto-rejoin).
   *
   * Off the hot path on purpose — small, well-formed imports don't
   * carry a duplicate string array per row. Lives only in memory
   * during the import-preview phase; never persisted to the
   * autosave blob (the user said they're OK losing it once the
   * session starts, the warning + edit affordance is enough to
   * catch issues up-front).
   */
  rawCells?: string[];
}

export interface ParseResult {
  items: Item[]; // deduped within this source
  warnings: DedupWarning[];
  detectedHeader: boolean; // result of `looksLikeHeader` on the parsed first row
}

/**
 * Parse a single CSV text into RawRows. Returns the rows BEFORE dedup so
 * dedup can be done in a unified pass across multiple sources.
 *
 * Also emits `extraColumns` warnings for rows that had MORE than the
 * expected 3 non-empty cells. This is almost always an unquoted comma
 * inside one of the fields (e.g. a label like `Foo, Bar, Baz` not
 * surrounded by `"` quotes parses into 3 cells, so `Foo` becomes the
 * label, `Bar` becomes the URL, and `Baz` becomes the image URL —
 * misaligning columns and silently dropping data). The warning is
 * advisory: we still produce a RawRow with our best-effort
 * label/url/imageUrl so the user can either (a) re-export the source
 * with proper quoting or (b) manually fix the row in the
 * EditItemModal using the attached `rawCells`.
 */
export function parseCsvRows(
  text: string,
  sourceName: string,
  skipHeader: boolean,
): {
  rows: RawRow[];
  detectedHeader: boolean;
  extraColumns: ExtraColumnsWarning[];
  commaInLabel: CommaInLabelWarning[];
} {
  const parsed = Papa.parse<string[]>(text, PAPA_COMMA_CSV_OPTIONS);
  const allRows = (parsed.data ?? []).filter(
    (r) => Array.isArray(r) && r.some((cell) => (cell ?? '').trim() !== ''),
  );
  if (allRows.length === 0) {
    return {
      rows: [],
      detectedHeader: false,
      extraColumns: [],
      commaInLabel: [],
    };
  }
  const detected = looksLikeHeader(allRows[0]);
  const dataRows = skipHeader ? allRows.slice(1) : allRows;
  const rows: RawRow[] = [];
  const extraColumns: ExtraColumnsWarning[] = [];
  const commaInLabel: CommaInLabelWarning[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const repair = repairCommaSplitRow(row);
    const label = repair.label;
    if (!label) continue;
    const url = repair.url;
    const imageUrl = repair.imageUrl;
    // Count NON-EMPTY cells (post-trim). Trailing empty columns from a
    // CSV with a uniform width on one bad row (e.g. `A,,,,`) shouldn't
    // trip the warning — those are syntactically extra cells but the
    // user clearly didn't intend any data in them. Quoted commas
    // (`"Foo, Bar",url,img`) collapse into a single cell at the
    // papaparse layer so they don't trip this either.
    const nonEmptyCells = row.reduce(
      (acc, c) => acc + ((c ?? '').trim() !== '' ? 1 : 0),
      0,
    );
    let rawCells: string[] | undefined;
    if (nonEmptyCells > 3) {
      // Snapshot the row verbatim so EditItemModal can show it to the
      // user. We DO want to keep trailing-empty cells here for fidelity
      // — the user might have a legit empty trailing field they want
      // to inspect — but we trim each cell so leading/trailing
      // whitespace doesn't leak into the modal display.
      rawCells = row.map((c) => (c ?? '').toString());
      extraColumns.push({
        sourceName,
        rowNumber: i + 1,
        cellCount: nonEmptyCells,
        rawCells,
        parsedAs: repair.naiveParsedAs,
      });
    } else if (repair.repaired) {
      rawCells = row.map((c) => (c ?? '').toString());
      commaInLabel.push({
        sourceName,
        rowNumber: i + 1,
        cellCount: repair.joinedCellCount,
        rawCells,
        naiveParsedAs: repair.naiveParsedAs,
        repairedLabel: label,
      });
    }
    rows.push({
      label,
      url,
      imageUrl,
      sourceName,
      sourceRow: i + 1,
      rawCells,
    });
  }
  return { rows, detectedHeader: detected, extraColumns, commaInLabel };
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
  /**
   * >3-non-empty-cell warnings for this source, mirrored from
   * `parseCsvRows`. Optional so callers that don't run through
   * `parseCsvRows` (e.g. the legacy/test paths that hand-build a
   * SourceParse) don't have to fabricate an empty array. `parseSources`
   * concatenates these across all sources into the top-level
   * `extraColumns` field of its return value.
   */
  extraColumns?: ExtraColumnsWarning[];
  /**
   * Comma-in-label auto-repair warnings for this source, mirrored from
   * `parseCsvRows`. Optional for hand-built SourceParse fixtures.
   */
  commaInLabel?: CommaInLabelWarning[];
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
 *
 * The returned `extraColumns` is the concatenation of every source's own
 * extraColumns array (or empty if a source didn't supply any). ImportPreview
 * surfaces these as soft warnings inline with the dedup warnings — the user
 * can still proceed, but is nudged to spot rows where an unquoted comma
 * silently misaligned columns.
 */
export function parseSources(sources: SourceParse[]): {
  items: Item[];
  warnings: DedupWarning[];
  extraColumns: ExtraColumnsWarning[];
  commaInLabel: CommaInLabelWarning[];
  perSource: Array<{
    sourceName: string;
    items: PreviewItem[]; // ordered, deduped within this source's own rows
  }>;
} {
  const perSource: Array<{ sourceName: string; items: PreviewItem[] }> = [];
  const flat: RawRow[] = [];
  const extraColumns: ExtraColumnsWarning[] = [];
  const commaInLabel: CommaInLabelWarning[] = [];
  for (const s of sources) {
    flat.push(...s.rawRows);
    if (s.extraColumns && s.extraColumns.length > 0) {
      extraColumns.push(...s.extraColumns);
    }
    if (s.commaInLabel && s.commaInLabel.length > 0) {
      commaInLabel.push(...s.commaInLabel);
    }
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
  return { items, warnings, extraColumns, commaInLabel, perSource };
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
