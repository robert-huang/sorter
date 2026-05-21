import { useCallback, useMemo, useRef, useState } from 'react';
import type { ExtraColumnsWarning, Item, SlotMeta } from '../lib/types';
import {
  canonicalKey,
  looksLikeHeader,
  parseCsvRows,
  parseExtrasText,
  parseSources,
  type RawRow,
  type SourceParse,
} from '../lib/csv';
import { ImportPreview, type PreviewSource } from './ImportPreview';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import Papa from 'papaparse';

/**
 * In-memory edit overlay for the START tab. Keyed by
 * `${sourceName}:${originalRowNumber}` because that handle is stable
 * across re-parses and is already shown to the user in the dedup
 * warning text.
 *
 * Each override field is independent — any subset may be present.
 * Semantics:
 *  - `label`: present means "rewrite the row's label".
 *  - `id`:    present means "force this idOverride on the RawRow".
 *  - `url` / `imageUrl`: an empty string means "explicitly clear the
 *    source's URL/IMAGE". A non-empty string sets it. A missing key
 *    means the source value is unchanged.
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
type OverlayMap = Map<
  string,
  { label?: string; id?: string; url?: string; imageUrl?: string }
>;

function overlayKey(sourceName: string, sourceRow: number): string {
  return `${sourceName}:${sourceRow}`;
}

function applyOverrides(rows: RawRow[], overrides: OverlayMap): RawRow[] {
  if (overrides.size === 0) return rows;
  return rows.map((r) => {
    const o = overrides.get(overlayKey(r.sourceName, r.sourceRow));
    if (!o) return r;
    const next: RawRow = { ...r };
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
function dropSourceFromOverrides(
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

type Mode = 'scratch' | 'preranked';

interface Props {
  /** Meta of the last-used slot we can resume; null when nothing to resume. */
  resumeMeta: SlotMeta | null;
  onResumeActive: () => void;
  onStartScratch: (items: Item[]) => void;
  onStartPreranked: (args: { sublists: Item[][]; extras: Item[] }) => void;
  /**
   * CSV-as-sorted entry point. Skips the sort entirely; items become the
   * frozen `sorted[]` of an insertion-mode slot. The user can later
   * "+ Add items" on RESULT to binary-insert new items.
   */
  onStartAlreadySorted: (items: Item[]) => void;
}

interface StagedFile {
  id: string;
  name: string;
  text: string;
  skipHeader: boolean;
  detectedHeader: boolean;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function StartScreen({
  resumeMeta,
  onResumeActive,
  onStartScratch,
  onStartPreranked,
  onStartAlreadySorted,
}: Props) {
  const [mode, setMode] = useState<Mode>('scratch');

  // Shared overlay across both modes. Entries are keyed by
  // `${sourceName}:${rowNumber}`, so the scratch source ('pasted CSV')
  // and any pre-ranked file or 'extras' use distinct keys naturally.
  const [overrides, setOverrides] = useState<OverlayMap>(new Map());

  // The dedup-warning row the user clicked Edit on. Drives the
  // EditItemModal. Stored as a transient object containing everything
  // the modal needs to render and write back to overrides on save.
  const [editTarget, setEditTarget] = useState<{
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
  } | null>(null);

  // -------- scratch mode --------
  const [scratchText, setScratchText] = useState('');
  const [scratchSkipHeader, setScratchSkipHeader] = useState(false);
  // When checked, the parsed items are treated as already-sorted: skip
  // the merge sort entirely and start the slot in insertion mode with
  // an empty pending list. The user can then "+ Add items" to insert
  // new items via binary insertion. See plan §6c.
  const [scratchAlreadySorted, setScratchAlreadySorted] = useState(false);
  const scratchFileRef = useRef<HTMLInputElement | null>(null);
  const scratchDetectedHeader = useMemo(() => {
    if (!scratchText.trim()) return false;
    const parsed = Papa.parse<string[]>(scratchText, {
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [scratchText]);

  const scratchParsed = useMemo(() => {
    if (!scratchText.trim()) {
      return {
        rows: [] as RawRow[],
        detectedHeader: false,
        extraColumns: [] as ExtraColumnsWarning[],
      };
    }
    return parseCsvRows(scratchText, 'pasted CSV', scratchSkipHeader);
  }, [scratchText, scratchSkipHeader]);

  const scratchSources: SourceParse[] = useMemo(
    () =>
      scratchParsed.rows.length > 0
        ? [
            {
              sourceName: 'pasted CSV',
              rawRows: applyOverrides(scratchParsed.rows, overrides),
              detectedHeader: scratchParsed.detectedHeader,
              extraColumns: scratchParsed.extraColumns,
            },
          ]
        : [],
    [scratchParsed, overrides],
  );

  const scratchResult = useMemo(
    () => parseSources(scratchSources),
    [scratchSources],
  );

  // Wrapper for setScratchText that also drops any overlay entries
  // tied to the 'pasted CSV' source. Necessary because edits to the
  // raw text typically shift row numbers and stale overrides would
  // then apply to unrelated rows.
  const updateScratchText = useCallback((next: string) => {
    setScratchText(next);
    setOverrides((prev) => dropSourceFromOverrides(prev, 'pasted CSV'));
  }, []);

  // Same reason: toggling the header-skip checkbox shifts every row's
  // sourceRow by ±1, so any existing overlay entry for 'pasted CSV'
  // would point at the wrong row after the toggle.
  const updateScratchSkipHeader = useCallback((next: boolean) => {
    setScratchSkipHeader(next);
    setOverrides((prev) => dropSourceFromOverrides(prev, 'pasted CSV'));
  }, []);

  function onScratchFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => updateScratchText(t));
    e.target.value = '';
  }

  function onStartScratchClick(): void {
    if (scratchAlreadySorted) {
      onStartAlreadySorted(scratchResult.items);
    } else {
      onStartScratch(scratchResult.items);
    }
  }

  const scratchPreviewSources: PreviewSource[] = useMemo(() => {
    if (scratchResult.perSource.length === 0) return [];
    return scratchResult.perSource;
  }, [scratchResult]);

  // -------- pre-ranked mode --------
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [extrasText, setExtrasText] = useState('');
  const [extrasSkipHeader, setExtrasSkipHeader] = useState(false);
  const prerankedFilesRef = useRef<HTMLInputElement | null>(null);

  const extrasDetectedHeader = useMemo(() => {
    if (!extrasText.trim()) return false;
    const parsed = Papa.parse<string[]>(extrasText, {
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [extrasText]);

  function onPrerankedFiles(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = e.target.files;
    if (!files) return;
    const promises = Array.from(files).map((f) =>
      f.text().then((t): StagedFile => {
        const parsed = Papa.parse<string[]>(t, {
          skipEmptyLines: 'greedy',
          preview: 1,
        });
        const first = parsed.data?.[0];
        const detected = Array.isArray(first) ? looksLikeHeader(first) : false;
        return {
          id: uid(),
          name: f.name,
          text: t,
          skipHeader: false,
          detectedHeader: detected,
        };
      }),
    );
    Promise.all(promises).then((arr) => {
      setStagedFiles((prev) => [...prev, ...arr]);
    });
    e.target.value = '';
  }

  function setStagedSkipHeader(id: string, skip: boolean): void {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) {
        // Header toggle shifts every row's sourceRow by ±1, so any
        // existing override for this file would land on the wrong row.
        setOverrides((cur) => dropSourceFromOverrides(cur, target.name));
      }
      return prev.map((f) => (f.id === id ? { ...f, skipHeader: skip } : f));
    });
  }

  function removeStaged(id: string): void {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) {
        setOverrides((cur) => dropSourceFromOverrides(cur, target.name));
      }
      return prev.filter((f) => f.id !== id);
    });
  }

  // Same invalidation rule for extras: any text/header change shifts
  // rows, so the 'extras' source's overrides are dropped.
  const updateExtrasText = useCallback((next: string) => {
    setExtrasText(next);
    setOverrides((prev) => dropSourceFromOverrides(prev, 'extras'));
  }, []);

  const updateExtrasSkipHeader = useCallback((next: boolean) => {
    setExtrasSkipHeader(next);
    setOverrides((prev) => dropSourceFromOverrides(prev, 'extras'));
  }, []);

  const prerankedResult = useMemo(() => {
    const sources: SourceParse[] = stagedFiles.map((f) => {
      const r = parseCsvRows(f.text, f.name, f.skipHeader);
      return {
        sourceName: f.name,
        rawRows: applyOverrides(r.rows, overrides),
        detectedHeader: r.detectedHeader,
        extraColumns: r.extraColumns,
      };
    });

    // Extras: treat the extras textarea as either a 1-column or multi-column
    // CSV depending on what was typed. If it parses as a CSV with URL/IMAGE
    // columns we honor them; otherwise treat each line as a label only.
    const extrasParsed = extrasText.trim()
      ? parseCsvRows(extrasText, 'extras', extrasSkipHeader)
      : {
          rows: [] as RawRow[],
          detectedHeader: false,
          extraColumns: [] as ExtraColumnsWarning[],
        };
    if (extrasParsed.rows.length === 0 && extrasText.trim()) {
      const plain = parseExtrasText(extrasText);
      if (plain.length > 0) {
        sources.push({
          sourceName: 'extras',
          rawRows: applyOverrides(plain, overrides),
          detectedHeader: false,
        });
      }
    } else if (extrasParsed.rows.length > 0) {
      sources.push({
        sourceName: 'extras',
        rawRows: applyOverrides(extrasParsed.rows, overrides),
        detectedHeader: extrasParsed.detectedHeader,
        extraColumns: extrasParsed.extraColumns,
      });
    }

    const result = parseSources(sources);
    // Split per-source items back into sublists vs extras using the per-source
    // list. The extras source is the one named 'extras'; everything else is a
    // sublist. We also need to filter the global deduped items down so each
    // appears exactly once (in the FIRST source that contained it).
    const seen = new Set<string>();
    const sublists: Item[][] = [];
    let extras: Item[] = [];
    for (const ps of result.perSource) {
      const isExtras = ps.sourceName === 'extras';
      const taken: Item[] = [];
      for (const pi of ps.items) {
        const it = pi.item;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        // Use the FULLY-merged item from the global dedup (it may have URL/
        // IMAGE filled in from a later source).
        const merged = result.items.find((m) => m.id === it.id) ?? it;
        taken.push(merged);
      }
      if (isExtras) {
        extras = taken;
      } else if (taken.length > 0) {
        sublists.push(taken);
      }
    }
    return {
      items: result.items,
      warnings: result.warnings,
      extraColumns: result.extraColumns,
      perSource: result.perSource,
      sublists,
      extras,
    };
  }, [stagedFiles, extrasText, extrasSkipHeader, overrides]);

  function onStartPrerankedClick(): void {
    onStartPreranked({
      sublists: prerankedResult.sublists,
      extras: prerankedResult.extras,
    });
  }

  // -------- edit-modal wiring (per-occurrence Edit in dedup warnings) --------
  //
  // The modal lives on StartScreen (not on ImportPreview) because we
  // need access to the live overrides state to read/write. ImportPreview
  // signals upward via onEditOccurrence; we resolve the row to the
  // actual RawRow it dedups to, build the otherIds collision map from
  // the current result, and stash everything in editTarget. The modal
  // reads from editTarget on render and writes back to overrides on
  // save.
  //
  // Reused for both scratch ('pasted CSV' source) and pre-ranked
  // (staged file names + 'extras').

  const buildOpenEdit = useCallback(
    (
      rawRows: RawRow[],
      result: { items: Item[] },
    ) =>
      (sourceName: string, rowNumber: number): void => {
        // Find the post-override RawRow for this occurrence so the
        // modal pre-fills with whatever the user has already typed in
        // a previous edit pass — not the original source-text value.
        const overridden = applyOverrides(rawRows, overrides);
        const row = overridden.find(
          (r) => r.sourceName === sourceName && r.sourceRow === rowNumber,
        );
        if (!row) return;
        // Match the id assignment dedup uses: explicit override wins,
        // otherwise canonicalKey(label). This stays correct even when
        // two rows have the same label and only one of them carries
        // an idOverride.
        const currentId = row.idOverride ?? canonicalKey(row.label);
        // Build otherIds: every id currently in the deduped result
        // EXCEPT the id this row currently maps to. That way the
        // collision check fires on a clash with any other existing
        // row, but a no-op edit (same id) doesn't trip it. We index
        // by id → label so the error message can name the colliding
        // item.
        const otherIds = new Map<string, string>();
        for (const it of result.items) {
          if (it.id === currentId) continue;
          otherIds.set(it.id, it.label);
        }
        setEditTarget({
          sourceName,
          rowNumber,
          currentLabel: row.label,
          currentId,
          currentUrl: row.url,
          currentImageUrl: row.imageUrl,
          otherIds,
          rawRow: row.rawCells,
        });
      },
    [overrides],
  );

  const onEditOccurrenceScratch = useMemo(
    () => buildOpenEdit(scratchParsed.rows, scratchResult),
    [buildOpenEdit, scratchParsed.rows, scratchResult],
  );

  const onEditOccurrencePreranked = useMemo(
    () => {
      // Flatten all source raw rows for the pre-ranked side so the
      // lookup can find the right row across staged files + extras.
      const allRawRows: RawRow[] = [];
      for (const f of stagedFiles) {
        const r = parseCsvRows(f.text, f.name, f.skipHeader);
        allRawRows.push(...r.rows);
      }
      if (extrasText.trim()) {
        const ex = parseCsvRows(extrasText, 'extras', extrasSkipHeader);
        if (ex.rows.length > 0) {
          allRawRows.push(...ex.rows);
        } else {
          allRawRows.push(...parseExtrasText(extrasText));
        }
      }
      return buildOpenEdit(allRawRows, prerankedResult);
    },
    [buildOpenEdit, stagedFiles, extrasText, extrasSkipHeader, prerankedResult],
  );

  const onEditSave = useCallback(
    (payload: EditItemSavePayload) => {
      if (!editTarget) return;
      const key = overlayKey(editTarget.sourceName, editTarget.rowNumber);
      setOverrides((prev) => {
        const next = new Map(prev);
        const cur = next.get(key) ?? {};
        const updated: {
          label?: string;
          id?: string;
          url?: string;
          imageUrl?: string;
        } = { ...cur };
        if (payload.label !== undefined && payload.label !== editTarget.currentLabel) {
          updated.label = payload.label;
        }
        if (payload.id !== undefined && payload.id !== editTarget.currentId) {
          updated.id = payload.id;
        }
        // URL / image: payload always carries empty string when the
        // user cleared the field. Compare against the row's current
        // value (treating undefined as '' for the comparison) so a
        // no-op pass-through doesn't write a redundant override. An
        // empty-string override IS meaningful when the source CSV
        // had a value — that's how the user clears mis-parsed URLs.
        if (payload.url !== undefined && payload.url !== (editTarget.currentUrl ?? '')) {
          updated.url = payload.url;
        }
        if (
          payload.imageUrl !== undefined &&
          payload.imageUrl !== (editTarget.currentImageUrl ?? '')
        ) {
          updated.imageUrl = payload.imageUrl;
        }
        // If no field actually changed vs the live values (e.g. user
        // opened the modal then saved without touching anything),
        // drop the entry rather than persisting a no-op.
        if (
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
      });
      setEditTarget(null);
    },
    [editTarget],
  );

  // Stub item passed into EditItemModal — we don't have a real
  // engine-side Item at this point (the user is pre-parse). Seeded
  // from editTarget so the modal's label / URL / image inputs all
  // pre-fill with whatever dedup currently sees (post-override).
  const editStubItem: Item | null = editTarget
    ? {
        id: editTarget.currentId,
        label: editTarget.currentLabel,
        url: editTarget.currentUrl,
        imageUrl: editTarget.currentImageUrl,
      }
    : null;

  // -------- render --------

  return (
    <div className="page">
      {resumeMeta && (
        <div className="resume-cta">
          <div className="grow">
            <div className="title">
              Resume{' '}
              <span className="resume-cta-slot-name">{resumeMeta.name}</span>{' '}
              {resumeMeta.done
                ? '(completed)'
                : `(${resumeMeta.comparisons} comparison${resumeMeta.comparisons === 1 ? '' : 's'} in)`}
            </div>
            <div className="sub">
              {resumeMeta.totalItems} items — last used slot. Other saved
              sorts are in the ⚙ gear menu.
            </div>
          </div>
          <button className="btn primary" onClick={onResumeActive}>
            Resume
          </button>
        </div>
      )}

      <div className="start-mode-toggle" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'scratch'}
          className={mode === 'scratch' ? 'active' : ''}
          onClick={() => setMode('scratch')}
        >
          Sort from scratch
        </button>
        <button
          role="tab"
          aria-selected={mode === 'preranked'}
          className={mode === 'preranked' ? 'active' : ''}
          onClick={() => setMode('preranked')}
        >
          Merge pre-ranked lists
        </button>
      </div>

      {mode === 'scratch' && (
        <div className="page-section">
          <h2>Sort from scratch</h2>
          <p className="csv-hint">
            One item per row. Format: <code>ITEM, URL (optional), IMAGE (optional)</code>
          </p>
          <textarea
            className="csv-textarea"
            placeholder={`Pit, https://example.com/pit, https://example.com/pit.jpg\nThe Mind, , https://example.com/mind.jpg\nCodenames`}
            value={scratchText}
            onChange={(e) => updateScratchText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn"
              onClick={() => scratchFileRef.current?.click()}
            >
              Load CSV file…
            </button>
            <input
              ref={scratchFileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              style={{ display: 'none' }}
              onChange={onScratchFile}
            />
          </div>
          <div className="checkbox-row">
            <input
              id="scratch-header"
              type="checkbox"
              checked={scratchSkipHeader}
              onChange={(e) => updateScratchSkipHeader(e.target.checked)}
            />
            <label htmlFor="scratch-header">First row is a header</label>
            {scratchDetectedHeader && !scratchSkipHeader && (
              <span className="header-hint">
                ⓘ Your first row looks like a header. Check the box to skip it.
              </span>
            )}
          </div>
          <div className="checkbox-row">
            <input
              id="scratch-already-sorted"
              type="checkbox"
              checked={scratchAlreadySorted}
              onChange={(e) => setScratchAlreadySorted(e.target.checked)}
            />
            <label htmlFor="scratch-already-sorted">
              These items are already in ranking order (skip the sort)
            </label>
            {scratchAlreadySorted && (
              <span className="header-hint">
                ⓘ Slot starts in insertion mode; add new items later via
                "+ Add items".
              </span>
            )}
          </div>
          <ImportPreview
            sources={scratchPreviewSources}
            totalItems={scratchResult.items.length}
            warnings={scratchResult.warnings}
            extraColumns={scratchResult.extraColumns}
            startLabel={
              scratchAlreadySorted
                ? `Use as ranking (${scratchResult.items.length} item${scratchResult.items.length === 1 ? '' : 's'})`
                : `Start sorting (${scratchResult.items.length} item${scratchResult.items.length === 1 ? '' : 's'})`
            }
            startDisabled={
              scratchAlreadySorted
                ? scratchResult.items.length < 1
                : scratchResult.items.length < 2
            }
            onStart={onStartScratchClick}
            onEditOccurrence={onEditOccurrenceScratch}
          />
        </div>
      )}

      {mode === 'preranked' && (
        <div className="page-section">
          <h2>Merge pre-ranked lists</h2>
          <p className="csv-hint">
            Upload one or more CSVs. Each file is treated as a sorted list; the
            row order is the user's expressed ranking within that file.
          </p>
          <div>
            <button
              className="btn"
              onClick={() => prerankedFilesRef.current?.click()}
            >
              Add CSV file(s)…
            </button>
            <input
              ref={prerankedFilesRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              multiple
              style={{ display: 'none' }}
              onChange={onPrerankedFiles}
            />
          </div>
          {stagedFiles.length > 0 && (
            <div className="file-list">
              {stagedFiles.map((f) => (
                <div className="file-row" key={f.id}>
                  <div className="info">
                    <div className="name">{f.name}</div>
                    <div className="meta">{f.text.length} bytes</div>
                    <div className="checkbox-row">
                      <input
                        id={`hdr-${f.id}`}
                        type="checkbox"
                        checked={f.skipHeader}
                        onChange={(e) =>
                          setStagedSkipHeader(f.id, e.target.checked)
                        }
                      />
                      <label htmlFor={`hdr-${f.id}`}>
                        First row is a header
                      </label>
                      {f.detectedHeader && !f.skipHeader && (
                        <span className="header-hint">
                          ⓘ Looks like a header. Check to skip.
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="x-button"
                    onClick={() => removeStaged(f.id)}
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <h2 style={{ fontSize: 14, color: 'var(--text-muted)' }}>
              Extras (unranked, optional)
            </h2>
            <p className="csv-hint">
              One label per line (or full CSV rows). These become singleton
              sublists at the <em>front</em> of the queue and get merged first.
            </p>
            <textarea
              className="csv-textarea"
              placeholder={`The Mind\nPit\nCodenames`}
              value={extrasText}
              onChange={(e) => updateExtrasText(e.target.value)}
              style={{ minHeight: 100 }}
            />
            <div className="checkbox-row">
              <input
                id="extras-header"
                type="checkbox"
                checked={extrasSkipHeader}
                onChange={(e) => updateExtrasSkipHeader(e.target.checked)}
              />
              <label htmlFor="extras-header">First row is a header</label>
              {extrasDetectedHeader && !extrasSkipHeader && (
                <span className="header-hint">
                  ⓘ Looks like a header. Check to skip.
                </span>
              )}
            </div>
          </div>

          <ImportPreview
            sources={prerankedResult.perSource}
            totalItems={prerankedResult.items.length}
            warnings={prerankedResult.warnings}
            extraColumns={prerankedResult.extraColumns}
            sublistCount={prerankedResult.sublists.length}
            singletonCount={prerankedResult.extras.length}
            startLabel={`Start sorting (${prerankedResult.items.length} item${prerankedResult.items.length === 1 ? '' : 's'})`}
            startDisabled={prerankedResult.items.length < 2}
            onStart={onStartPrerankedClick}
            onEditOccurrence={onEditOccurrencePreranked}
          />
        </div>
      )}

      {editStubItem && editTarget && (
        <EditItemModal
          item={editStubItem}
          onCancel={() => setEditTarget(null)}
          onSave={onEditSave}
          allowEditId
          currentId={editTarget.currentId}
          otherIds={editTarget.otherIds}
          rawRow={editTarget.rawRow}
        />
      )}
    </div>
  );
}
