import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { TabId } from './Header';
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
import { AnilistStartMode } from './AnilistStartMode';
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

/** Rows the user removed from the import preview (keyed like overrides). */
type ExcludedRows = Set<string>;

function dropSourceFromExclusions(
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

function applyImportEdits(
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

function filterExtraColumnsForExcluded(
  warnings: ExtraColumnsWarning[],
  excluded: ExcludedRows,
): ExtraColumnsWarning[] {
  if (excluded.size === 0) return warnings;
  return warnings.filter(
    (w) => !excluded.has(overlayKey(w.sourceName, w.rowNumber)),
  );
}

/** Exclude every row in `sourceName` that dedups to the same id as `rowNumber`. */
function excludePreviewItemFromSource(
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

function dropSourceEdits(
  sourceName: string,
  setOverrides: Dispatch<SetStateAction<OverlayMap>>,
  setExcludedRows: Dispatch<SetStateAction<ExcludedRows>>,
): void {
  setOverrides((prev) => dropSourceFromOverrides(prev, sourceName));
  setExcludedRows((prev) => dropSourceFromExclusions(prev, sourceName));
}

type Mode = 'scratch' | 'preranked' | 'anilist';

/** Which main tabs the current START draft can adopt into. */
export interface StartDraftCapabilities {
  canList: boolean;
  canRank: boolean;
  canResult: boolean;
}

export type StartDraftAdoptTab = Exclude<TabId, 'start'>;

export interface StartScreenHandle {
  /** Mint a new slot from the in-progress START draft and land on `tab`. */
  tryAdoptDraft: (tab: StartDraftAdoptTab) => boolean;
}

interface Props {
  /** Meta of the last-used slot we can resume; null when nothing to resume. */
  resumeMeta: SlotMeta | null;
  onResumeActive: () => void;
  onStartScratch: (items: Item[], initialTab?: TabId) => void;
  onStartPreranked: (
    args: { sublists: Item[][]; extras: Item[] },
    initialTab?: TabId,
  ) => void;
  /**
   * CSV-as-sorted entry point. Skips the sort entirely; items become the
   * frozen `sorted[]` of an insertion-mode slot. The user can later
   * "+ Add items" on RESULT to binary-insert new items.
   */
  onStartAlreadySorted: (items: Item[], initialTab?: TabId) => void;
  /** True while a prior slot is loaded in memory — editing START should park it. */
  hasLoadedSession: boolean;
  /** Called on first meaningful START input while `hasLoadedSession` is true. */
  onDraftActivity: () => void;
  onDraftCapabilitiesChange: (caps: StartDraftCapabilities) => void;
}

interface StagedFile {
  id: string;
  name: string;
  text: string;
  skipHeader: boolean;
  detectedHeader: boolean;
  /** Staged from the paste textarea (vs an uploaded file). */
  pasted?: boolean;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const StartScreen = forwardRef<StartScreenHandle, Props>(function StartScreen(
  {
    resumeMeta,
    onResumeActive,
    onStartScratch,
    onStartPreranked,
    onStartAlreadySorted,
    hasLoadedSession,
    onDraftActivity,
    onDraftCapabilitiesChange,
  },
  ref,
) {
  const [mode, setMode] = useState<Mode>('scratch');

  const prevLoadedSessionRef = useRef(hasLoadedSession);

  const notifyDraftActivity = useCallback(() => {
    if (hasLoadedSession) onDraftActivity();
  }, [hasLoadedSession, onDraftActivity]);

  // Shared overlay across both modes. Entries are keyed by
  // `${sourceName}:${rowNumber}`, so the scratch source ('pasted CSV')
  // and any pre-ranked file or 'extras' use distinct keys naturally.
  const [overrides, setOverrides] = useState<OverlayMap>(new Map());
  const [excludedRows, setExcludedRows] = useState<ExcludedRows>(new Set());

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
              rawRows: applyImportEdits(scratchParsed.rows, overrides, excludedRows),
              detectedHeader: scratchParsed.detectedHeader,
              extraColumns: filterExtraColumnsForExcluded(
                scratchParsed.extraColumns,
                excludedRows,
              ),
            },
          ]
        : [],
    [scratchParsed, overrides, excludedRows],
  );

  const scratchResult = useMemo(
    () => parseSources(scratchSources),
    [scratchSources],
  );

  // Wrapper for setScratchText that also drops any overlay entries
  // tied to the 'pasted CSV' source. Necessary because edits to the
  // raw text typically shift row numbers and stale overrides would
  // then apply to unrelated rows.
  const updateScratchText = useCallback(
    (next: string) => {
      setScratchText(next);
      dropSourceEdits('pasted CSV', setOverrides, setExcludedRows);
      if (next.trim()) notifyDraftActivity();
    },
    [notifyDraftActivity],
  );

  // Same reason: toggling the header-skip checkbox shifts every row's
  // sourceRow by ±1, so any existing overlay entry for 'pasted CSV'
  // would point at the wrong row after the toggle.
  const updateScratchSkipHeader = useCallback(
    (next: boolean) => {
      setScratchSkipHeader(next);
      dropSourceEdits('pasted CSV', setOverrides, setExcludedRows);
      notifyDraftActivity();
    },
    [notifyDraftActivity],
  );

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
  const [pasteText, setPasteText] = useState('');
  const [pasteSkipHeader, setPasteSkipHeader] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const prerankedFilesRef = useRef<HTMLInputElement | null>(null);
  const pasteTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const pasteDetectedHeader = useMemo(() => {
    if (!pasteText.trim()) return false;
    const parsed = Papa.parse<string[]>(pasteText, {
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [pasteText]);

  function nextPastedListName(existing: StagedFile[]): string {
    let n = 1;
    while (existing.some((f) => f.name === `pasted list ${n}`)) n++;
    return `pasted list ${n}`;
  }

  function addPastedList(): void {
    if (!pasteText.trim()) return;
    setPasteError(null);
    setStagedFiles((prev) => [
      ...prev,
      {
        id: uid(),
        name: nextPastedListName(prev),
        text: pasteText,
        skipHeader: pasteSkipHeader,
        detectedHeader: pasteDetectedHeader,
        pasted: true,
      },
    ]);
    setPasteText('');
    setPasteSkipHeader(false);
    notifyDraftActivity();
  }

  function restorePastedListToEditor(id: string): void {
    const target = stagedFiles.find((f) => f.id === id);
    if (!target?.pasted) return;
    setPasteText(target.text);
    setPasteSkipHeader(target.skipHeader);
    setPasteError(null);
    dropSourceEdits(target.name, setOverrides, setExcludedRows);
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
    requestAnimationFrame(() => {
      pasteTextareaRef.current?.focus();
      pasteTextareaRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    });
  }

  async function pasteFromClipboard(): Promise<void> {
    setPasteError(null);
    try {
      const text = await navigator.clipboard.readText();
      setPasteText(text);
      if (text.trim()) notifyDraftActivity();
    } catch {
      setPasteError(
        'Could not read clipboard. Paste into the box with ⌘V / Ctrl+V instead.',
      );
    }
  }

  const [extrasText, setExtrasText] = useState('');
  const [extrasSkipHeader, setExtrasSkipHeader] = useState(false);

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
      if (arr.length > 0) notifyDraftActivity();
    });
    e.target.value = '';
  }

  function setStagedSkipHeader(id: string, skip: boolean): void {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) {
        // Header toggle shifts every row's sourceRow by ±1, so any
        // existing override for this file would land on the wrong row.
        dropSourceEdits(target.name, setOverrides, setExcludedRows);
      }
      return prev.map((f) => (f.id === id ? { ...f, skipHeader: skip } : f));
    });
  }

  function removeStaged(id: string): void {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target) {
        dropSourceEdits(target.name, setOverrides, setExcludedRows);
      }
      return prev.filter((f) => f.id !== id);
    });
  }

  // Same invalidation rule for extras: any text/header change shifts
  // rows, so the 'extras' source's overrides are dropped.
  const updateExtrasText = useCallback(
    (next: string) => {
      setExtrasText(next);
      dropSourceEdits('extras', setOverrides, setExcludedRows);
      if (next.trim()) notifyDraftActivity();
    },
    [notifyDraftActivity],
  );

  const updateExtrasSkipHeader = useCallback(
    (next: boolean) => {
      setExtrasSkipHeader(next);
      dropSourceEdits('extras', setOverrides, setExcludedRows);
      notifyDraftActivity();
    },
    [notifyDraftActivity],
  );

  const prerankedResult = useMemo(() => {
    const sources: SourceParse[] = stagedFiles.map((f) => {
      const r = parseCsvRows(f.text, f.name, f.skipHeader);
      return {
        sourceName: f.name,
        rawRows: applyImportEdits(r.rows, overrides, excludedRows),
        detectedHeader: r.detectedHeader,
        extraColumns: filterExtraColumnsForExcluded(r.extraColumns, excludedRows),
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
          rawRows: applyImportEdits(plain, overrides, excludedRows),
          detectedHeader: false,
        });
      }
    } else if (extrasParsed.rows.length > 0) {
      sources.push({
        sourceName: 'extras',
        rawRows: applyImportEdits(extrasParsed.rows, overrides, excludedRows),
        detectedHeader: extrasParsed.detectedHeader,
        extraColumns: filterExtraColumnsForExcluded(
          extrasParsed.extraColumns,
          excludedRows,
        ),
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
  }, [stagedFiles, extrasText, extrasSkipHeader, overrides, excludedRows]);

  function clearDraftState(): void {
    setMode('scratch');
    setOverrides(new Map());
    setExcludedRows(new Set());
    setScratchText('');
    setScratchSkipHeader(false);
    setScratchAlreadySorted(false);
    setStagedFiles([]);
    setPasteText('');
    setPasteSkipHeader(false);
    setPasteError(null);
    setExtrasText('');
    setExtrasSkipHeader(false);
    setEditTarget(null);
  }

  function draftHasContent(): boolean {
    if (mode === 'scratch') return scratchText.trim().length > 0;
    return stagedFiles.length > 0 || extrasText.trim().length > 0;
  }

  // Resume loads the previous slot — discard any in-progress START draft so
  // the user isn't looking at stale import text for a different session.
  useEffect(() => {
    if (!prevLoadedSessionRef.current && hasLoadedSession) {
      clearDraftState();
    }
    prevLoadedSessionRef.current = hasLoadedSession;
  }, [hasLoadedSession]);

  useEffect(() => {
    // AniList mode owns its own "Sort N selected items" CTA and reads
    // its selection state internally; we don't surface it up to the
    // capabilities API. Tab adoption while in anilist mode is therefore
    // always disabled — the user moves forward via the dedicated CTA,
    // not by clicking the header's RANK / LIST tabs.
    if (mode === 'anilist') {
      onDraftCapabilitiesChange({
        canList: false,
        canRank: false,
        canResult: false,
      });
      return;
    }
    onDraftCapabilitiesChange({
      canList:
        mode === 'scratch'
          ? scratchResult.items.length >= 1
          : prerankedResult.items.length >= 1,
      canRank:
        mode === 'scratch'
          ? !scratchAlreadySorted && scratchResult.items.length >= 2
          : prerankedResult.items.length >= 2,
      canResult:
        mode === 'scratch' &&
        scratchAlreadySorted &&
        scratchResult.items.length >= 1,
    });
  }, [
    mode,
    scratchResult.items.length,
    prerankedResult.items.length,
    scratchAlreadySorted,
    onDraftCapabilitiesChange,
  ]);

  useEffect(() => {
    return () => {
      onDraftCapabilitiesChange({
        canList: false,
        canRank: false,
        canResult: false,
      });
    };
  }, [onDraftCapabilitiesChange]);

  useImperativeHandle(
    ref,
    () => ({
      tryAdoptDraft(tab: StartDraftAdoptTab): boolean {
        if (!draftHasContent()) return false;

        if (mode === 'scratch') {
          if (scratchAlreadySorted) {
            if (scratchResult.items.length < 1) return false;
            if (tab === 'result' || tab === 'list') {
              onStartAlreadySorted(scratchResult.items, tab);
              return true;
            }
            return false;
          }
          if (tab === 'list' && scratchResult.items.length >= 1) {
            onStartScratch(scratchResult.items, 'list');
            return true;
          }
          if (tab === 'rank' && scratchResult.items.length >= 2) {
            onStartScratch(scratchResult.items, 'rank');
            return true;
          }
          return false;
        }

        if (tab === 'list' && prerankedResult.items.length >= 1) {
          onStartPreranked(
            {
              sublists: prerankedResult.sublists,
              extras: prerankedResult.extras,
            },
            'list',
          );
          return true;
        }
        if (tab === 'rank' && prerankedResult.items.length >= 2) {
          onStartPreranked(
            {
              sublists: prerankedResult.sublists,
              extras: prerankedResult.extras,
            },
            'rank',
          );
          return true;
        }
        return false;
      },
    }),
    [
      mode,
      scratchText,
      stagedFiles,
      extrasText,
      scratchAlreadySorted,
      scratchResult,
      prerankedResult,
      onStartScratch,
      onStartPreranked,
      onStartAlreadySorted,
    ],
  );

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

  const onRemovePreviewRowScratch = useCallback(
    (sourceName: string, rowNumber: number) => {
      setExcludedRows((prev) =>
        excludePreviewItemFromSource(
          scratchParsed.rows,
          overrides,
          prev,
          sourceName,
          rowNumber,
        ),
      );
    },
    [scratchParsed.rows, overrides],
  );

  const onRemovePreviewRowPreranked = useCallback(
    (sourceName: string, rowNumber: number) => {
      const allRawRows: RawRow[] = [];
      for (const f of stagedFiles) {
        allRawRows.push(...parseCsvRows(f.text, f.name, f.skipHeader).rows);
      }
      if (extrasText.trim()) {
        const ex = parseCsvRows(extrasText, 'extras', extrasSkipHeader);
        if (ex.rows.length > 0) allRawRows.push(...ex.rows);
        else allRawRows.push(...parseExtrasText(extrasText));
      }
      setExcludedRows((prev) =>
        excludePreviewItemFromSource(
          allRawRows,
          overrides,
          prev,
          sourceName,
          rowNumber,
        ),
      );
    },
    [stagedFiles, extrasText, extrasSkipHeader, overrides],
  );

  const onEditSave = useCallback(
    (payload: EditItemSavePayload) => {
      if (!editTarget) return;
      const key = overlayKey(editTarget.sourceName, editTarget.rowNumber);
      const hasChange =
        (payload.label !== undefined && payload.label !== editTarget.currentLabel) ||
        (payload.id !== undefined && payload.id !== editTarget.currentId) ||
        (payload.url !== undefined && payload.url !== (editTarget.currentUrl ?? '')) ||
        (payload.imageUrl !== undefined &&
          payload.imageUrl !== (editTarget.currentImageUrl ?? ''));
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
      if (hasChange) notifyDraftActivity();
      setEditTarget(null);
    },
    [editTarget, notifyDraftActivity],
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
        <button
          role="tab"
          aria-selected={mode === 'anilist'}
          className={mode === 'anilist' ? 'active' : ''}
          onClick={() => setMode('anilist')}
        >
          Import from AniList
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
              onChange={(e) => {
                setScratchAlreadySorted(e.target.checked);
                notifyDraftActivity();
              }}
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
            onRemoveRow={onRemovePreviewRowScratch}
          />
        </div>
      )}

      {mode === 'preranked' && (
        <div className="page-section">
          <h2>Merge pre-ranked lists</h2>
          <p className="csv-hint">
            Paste or upload one or more CSVs. Each list is treated as a sorted
            sublist; the row order is the user's expressed ranking within that
            list.
          </p>
          <textarea
            ref={pasteTextareaRef}
            className="csv-textarea"
            placeholder={`Pit, https://example.com/pit\nThe Mind\nCodenames`}
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteError(null);
              if (e.target.value.trim()) notifyDraftActivity();
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              className="btn"
              onClick={addPastedList}
              disabled={!pasteText.trim()}
            >
              Add pasted list
            </button>
            <button className="btn" onClick={() => void pasteFromClipboard()}>
              Paste from clipboard
            </button>
            <button
              className="btn"
              onClick={() => prerankedFilesRef.current?.click()}
            >
              Load CSV file(s)…
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
          {pasteError && (
            <p style={{ marginTop: 8, color: 'var(--warning)', fontSize: 13 }}>
              {pasteError}
            </p>
          )}
          <div className="checkbox-row">
            <input
              id="paste-header"
              type="checkbox"
              checked={pasteSkipHeader}
              onChange={(e) => setPasteSkipHeader(e.target.checked)}
            />
            <label htmlFor="paste-header">First row is a header (pasted list)</label>
            {pasteDetectedHeader && !pasteSkipHeader && (
              <span className="header-hint">
                ⓘ Your first row looks like a header. Check the box to skip it.
              </span>
            )}
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
                  <div className="file-row-actions">
                    {f.pasted && (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => restorePastedListToEditor(f.id)}
                        title="Remove this list and put its CSV back in the paste box to edit"
                      >
                        Edit in paste box
                      </button>
                    )}
                    <button
                      className="x-button"
                      onClick={() => removeStaged(f.id)}
                      aria-label={`Remove ${f.name}`}
                    >
                      ×
                    </button>
                  </div>
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
            onRemoveRow={onRemovePreviewRowPreranked}
          />
        </div>
      )}

      {mode === 'anilist' && (
        <AnilistStartMode
          onStartScratch={(items) => onStartScratch(items)}
          onDraftActivity={notifyDraftActivity}
        />
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
});
