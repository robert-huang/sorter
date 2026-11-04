import type {
  CommaInLabelWarning,
  ExtraColumnsWarning,
  Item,
} from '../lib/types';
import { canonicalKey, type RawRow } from '../lib/csv';
import type { AnilistHydrationResult } from '../lib/importers/anilist/anilistPlaintextHydration';
import type { EditItemSavePayload } from './EditItemModal';
import type { PreviewSource } from './ImportPreview';

/**
 * In-memory edit overlay for an import preview. Keyed by
 * `${sourceName}:${originalRowNumber}` because that handle is stable
 * across re-parses and is already shown to the user in the dedup
 * warnings ("Inception (top10.csv row 1)").
 *
 * Each override field is independent — any subset may be present.
 * Semantics:
 *  - `label`: present means "rewrite the row's label".
 *  - `id`:    present means "force this idOverride on the RawRow".
 *  - `url` / `imageUrl`: an empty string means "explicitly clear the
 *    source's URL/IMAGE". A non-empty string sets it. A missing key
 *    means the source value is unchanged.
 *  - `replacement`: complete cache-backed metadata for a canonical
 *    AniList id; explicit field overrides still win.
 *
 * The overlay is applied to RawRow values BEFORE parseSources runs
 * its dedup pass, so the user can disambiguate two rows that collapse
 * to the same canonical id (rename one's label, or assign one an
 * explicit id) AND fix mis-parsed URL/image metadata without going
 * back to the raw CSV.
 *
 * Brutally cleared on any source-text mutation (textarea edit, file
 * replaced/removed, header-skip toggle) because row numbers shift
 * and we'd otherwise apply stale overrides to unrelated rows.
 */
export type OverlayMap = Map<
  string,
  {
    replacement?: Item;
    label?: string;
    id?: string;
    url?: string;
    imageUrl?: string;
  }
>;

/** Rows the user removed from the import preview (keyed like overrides). */
export type ExcludedRows = Set<string>;

/** Everything EditItemModal needs to edit one preview row and write it back. */
export interface ImportEditTarget {
  sourceName: string;
  rowNumber: number;
  /** The label dedup actually saw (post-override). Pre-fills the modal. */
  currentLabel: string;
  /** The id dedup actually saw (post-override). Pre-fills the advanced field. */
  currentId: string;
  /** Current url/image (post-override). Pre-fills the URL / Image URL fields. */
  currentUrl: string | undefined;
  currentImageUrl: string | undefined;
  /** All other ids in the current preview (excludes this row), for collision check. */
  otherIds: Map<string, string>;
  /**
   * Verbatim parsed cells when the originating row tripped an
   * `ExtraColumnsWarning`. Forwarded to EditItemModal as `rawRow` so
   * the user can manually copy substrings into the right fields when
   * an unquoted comma broke the parse. Undefined for rows that
   * parsed cleanly — the modal then renders without the
   * "Original row" panel, same as before.
   */
  rawRow: string[] | undefined;
}

export function overlayKey(sourceName: string, sourceRow: number): string {
  return `${sourceName}:${sourceRow}`;
}

export function applyOverrides(rows: RawRow[], overrides: OverlayMap): RawRow[] {
  if (overrides.size === 0) return rows;
  return rows.map((r) => {
    const o = overrides.get(overlayKey(r.sourceName, r.sourceRow));
    if (!o) return r;
    const next: RawRow = { ...r };
    if (o.replacement !== undefined) next.itemOverride = o.replacement;
    if (o.label !== undefined) next.label = o.label;
    if (o.id !== undefined) next.idOverride = o.id;
    // For url/imageUrl, empty-string overrides are treated as
    // "explicitly cleared" — RawRow uses `undefined` to mean missing,
    // so map '' → undefined while still distinguishing "no override"
    // (key absent) from "cleared" (key present and empty).
    if (o.url !== undefined) next.url = o.url || undefined;
    if (o.imageUrl !== undefined) next.imageUrl = o.imageUrl || undefined;
    return next;
  });
}

/** Drop every overlay entry whose key is sourced from `sourceName`. */
export function dropSourceFromOverrides(
  overrides: OverlayMap,
  sourceName: string,
): OverlayMap {
  if (overrides.size === 0) return overrides;
  const prefix = `${sourceName}:`;
  let touched = false;
  const next = new Map(overrides);
  for (const k of next.keys()) {
    if (k.startsWith(prefix)) {
      next.delete(k);
      touched = true;
    }
  }
  return touched ? next : overrides;
}

export function dropSourceFromExclusions(
  excluded: ExcludedRows,
  sourceName: string,
): ExcludedRows {
  if (excluded.size === 0) return excluded;
  const prefix = `${sourceName}:`;
  const next = new Set<string>();
  let touched = false;
  for (const k of excluded) {
    if (k.startsWith(prefix)) touched = true;
    else next.add(k);
  }
  return touched ? next : excluded;
}

export function applyImportEdits(
  rows: RawRow[],
  overrides: OverlayMap,
  excluded: ExcludedRows,
): RawRow[] {
  const overridden = applyOverrides(rows, overrides);
  if (excluded.size === 0) return overridden;
  return overridden.filter(
    (r) => !excluded.has(overlayKey(r.sourceName, r.sourceRow)),
  );
}

export function filterExtraColumnsForExcluded(
  warnings: ExtraColumnsWarning[],
  excluded: ExcludedRows,
): ExtraColumnsWarning[] {
  if (excluded.size === 0) return warnings;
  return warnings.filter(
    (w) => !excluded.has(overlayKey(w.sourceName, w.rowNumber)),
  );
}

export function filterCommaInLabelForExcluded(
  warnings: CommaInLabelWarning[],
  excluded: ExcludedRows,
): CommaInLabelWarning[] {
  if (excluded.size === 0) return warnings;
  return warnings.filter(
    (w) => !excluded.has(overlayKey(w.sourceName, w.rowNumber)),
  );
}

/** Exclude every row in `sourceName` that dedups to the same id as `rowNumber`. */
export function excludePreviewItemFromSource(
  rows: RawRow[],
  overrides: OverlayMap,
  excluded: ExcludedRows,
  sourceName: string,
  rowNumber: number,
): ExcludedRows {
  const overridden = applyOverrides(rows, overrides);
  const target = overridden.find(
    (r) => r.sourceName === sourceName && r.sourceRow === rowNumber,
  );
  if (!target) return excluded;
  const targetId = target.idOverride ?? canonicalKey(target.label);
  const next = new Set(excluded);
  for (const r of overridden) {
    if (r.sourceName !== sourceName) continue;
    const id = r.idOverride ?? canonicalKey(r.label);
    if (id === targetId) next.add(overlayKey(r.sourceName, r.sourceRow));
  }
  return next;
}

/** Writes AniList hydration results into the overlay so the preview shows them. */
export function applyStartScreenHydration(
  current: OverlayMap,
  inputItems: readonly Item[],
  previewSources: readonly PreviewSource[],
  result: AnilistHydrationResult,
): OverlayMap {
  const unresolved = new Set(result.issues.map(({ itemId }) => itemId));
  const hydratedByOriginalId = new Map<string, Item>();
  inputItems.forEach((item, index) => {
    const hydrated = result.items[index];
    if (!unresolved.has(item.id) && hydrated) {
      hydratedByOriginalId.set(item.id, hydrated);
    }
  });
  const next = new Map(current);
  previewSources.forEach((source) => {
    source.items.forEach(({ item, sourceRow }) => {
      const hydrated = hydratedByOriginalId.get(item.id);
      if (!hydrated) return;
      next.set(overlayKey(source.sourceName, sourceRow), {
        replacement: hydrated,
        id: hydrated.id,
        label: hydrated.label,
        url: hydrated.url ?? '',
        imageUrl: hydrated.imageUrl ?? '',
      });
    });
  });
  return next;
}

/**
 * Resolves one preview row to its post-override values plus the collision
 * map EditItemModal checks against. Null when the row no longer exists.
 */
export function buildImportEditTarget(
  rawRows: RawRow[],
  overrides: OverlayMap,
  resultItems: readonly Item[],
  sourceName: string,
  rowNumber: number,
): ImportEditTarget | null {
  // Find the post-override RawRow for this occurrence so the
  // modal pre-fills with whatever the user has already typed in
  // a previous edit pass — not the original source-text value.
  const row = applyOverrides(rawRows, overrides).find(
    (r) => r.sourceName === sourceName && r.sourceRow === rowNumber,
  );
  if (!row) return null;
  // Match the id assignment dedup uses: explicit override wins,
  // otherwise canonicalKey(label). This stays correct even when
  // two rows have the same label and only one of them carries
  // an idOverride.
  const currentId = row.idOverride ?? canonicalKey(row.label);
  // Every id currently in the deduped result EXCEPT the one this row
  // maps to, so a no-op edit doesn't trip the collision check.
  const otherIds = new Map<string, string>();
  for (const it of resultItems) {
    if (it.id === currentId) continue;
    otherIds.set(it.id, it.label);
  }
  return {
    sourceName,
    rowNumber,
    currentLabel: row.label,
    currentId,
    currentUrl: row.url,
    currentImageUrl: row.imageUrl,
    otherIds,
    rawRow: row.rawCells,
  };
}

/** True when saving `payload` would change anything about the target row. */
export function importEditHasChange(
  target: ImportEditTarget,
  payload: EditItemSavePayload,
): boolean {
  return (
    payload.hydratedItem !== undefined ||
    (payload.label !== undefined && payload.label !== target.currentLabel) ||
    (payload.id !== undefined && payload.id !== target.currentId) ||
    (payload.url !== undefined && payload.url !== (target.currentUrl ?? '')) ||
    (payload.imageUrl !== undefined &&
      payload.imageUrl !== (target.currentImageUrl ?? ''))
  );
}

/** Merges an EditItemModal save into the overlay entry for the target row. */
export function applyImportEditPayload(
  prev: OverlayMap,
  target: ImportEditTarget,
  payload: EditItemSavePayload,
): OverlayMap {
  const key = overlayKey(target.sourceName, target.rowNumber);
  const next = new Map(prev);
  const updated = { ...(next.get(key) ?? {}) };
  if (payload.hydratedItem !== undefined) {
    updated.replacement = payload.hydratedItem;
    updated.id = payload.id ?? payload.hydratedItem.id;
    updated.label = payload.label ?? payload.hydratedItem.label;
    updated.url = payload.url ?? payload.hydratedItem.url ?? '';
    updated.imageUrl = payload.imageUrl ?? payload.hydratedItem.imageUrl ?? '';
  }
  if (payload.label !== undefined && payload.label !== target.currentLabel) {
    updated.label = payload.label;
  }
  if (payload.id !== undefined && payload.id !== target.currentId) {
    updated.id = payload.id;
  }
  // URL / image: payload always carries empty string when the
  // user cleared the field. Compare against the row's current
  // value (treating undefined as '' for the comparison) so a
  // no-op pass-through doesn't write a redundant override. An
  // empty-string override IS meaningful when the source CSV
  // had a value — that's how the user clears mis-parsed URLs.
  if (payload.url !== undefined && payload.url !== (target.currentUrl ?? '')) {
    updated.url = payload.url;
  }
  if (
    payload.imageUrl !== undefined &&
    payload.imageUrl !== (target.currentImageUrl ?? '')
  ) {
    updated.imageUrl = payload.imageUrl;
  }
  // If no field actually changed vs the live values (e.g. user
  // opened the modal then saved without touching anything),
  // drop the entry rather than persisting a no-op.
  if (
    updated.replacement === undefined &&
    updated.label === undefined &&
    updated.id === undefined &&
    updated.url === undefined &&
    updated.imageUrl === undefined
  ) {
    next.delete(key);
  } else {
    next.set(key, updated);
  }
  return next;
}
