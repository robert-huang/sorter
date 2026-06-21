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
import type {
  CommaInLabelWarning,
  ExtraColumnsWarning,
  Item,
  ItemId,
  SlotMeta,
} from '../lib/types';
import {
  canonicalKey,
  looksLikeHeader,
  parseCsvRows,
  parseExtrasText,
  parseSources,
  PAPA_COMMA_CSV_OPTIONS,
  type RawRow,
  type SourceParse,
} from '../lib/csv';
import { subscribeAnilistDisplayPreferences } from '../lib/importers/anilist/displayPreferences';
import { relabelAnilistItemPreservingFormat } from '../lib/importers/anilist/anilistItemLabel';
import { AnilistStartMode } from './AnilistStartMode';
import { ImportPreview, type PreviewSource } from './ImportPreview';
import { EditItemModal, type EditItemSavePayload } from './EditItemModal';
import {
  StagedItemsPanel,
  buildSortInputFromStaged,
  type StagedGroup,
  type StagedGroupInput,
  type StartMode,
} from './StagedItemsPanel';
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

function filterCommaInLabelForExcluded(
  warnings: CommaInLabelWarning[],
  excluded: ExcludedRows,
): CommaInLabelWarning[] {
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
  /** True when START has in-memory draft work that tab navigation would consume or leaving would lose. */
  hasLosableDraft: boolean;
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
   * Insertion-mode start. Same combined draft as `onStartPreranked`, but
   * seeds the binary-insertion engine (largest pre-ranked sublist becomes
   * the frozen `sorted[]`, everything else binary-inserts one at a time).
   * Chosen via the Start Sort split-button's "Insertion sort" option.
   */
  onStartInsertion: (
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
  /**
   * Bumped by App.tsx after any push / pull / dirty-bump on the source
   * DB. Forwarded to `AnilistStartMode` so its cache-hint lookups
   * re-run after the user pulls fresh data in (the in-memory cache
   * effects are otherwise keyed only on username / type / import +
   * fav ticks, which a Drive pull doesn't touch).
   */
  dbSyncRevision: number;
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
    // onStartScratch is kept on the Props interface for backwards
    // compatibility with App.tsx, but with the staging refactor all
    // single-tab starts now route through onStartPreranked (which
    // handles `sublists: [], extras: items` identically to the old
    // initSort path — see seedFromSublists).
    onStartScratch: _onStartScratch,
    onStartPreranked,
    onStartInsertion,
    onStartAlreadySorted,
    hasLoadedSession,
    onDraftActivity,
    onDraftCapabilitiesChange,
    dbSyncRevision,
  },
  ref,
) {
  const [mode, setMode] = useState<Mode>('scratch');
  // Engine for the Start Sort split-button. Non-persisted and per-draft:
  // it resets to 'merge' whenever the draft is cleared (see
  // `clearDraftState`). Routes both the panel's Start button and
  // header-tab adoption (`tryAdoptDraft`) via `startFromCombined`.
  const [startMode, setStartMode] = useState<StartMode>('merge');

  const prevLoadedSessionRef = useRef(hasLoadedSession);

  const notifyDraftActivity = useCallback(() => {
    if (hasLoadedSession) onDraftActivity();
  }, [hasLoadedSession, onDraftActivity]);

  // -------- shared staging --------
  //
  // Each tab (scratch / pre-ranked / anilist) appends to this list
  // via its own "Add to staged" CTA. The Start sort button at the
  // bottom of the page collapses these into the (sublists, extras)
  // shape the sort engine consumes — see `buildSortInputFromStaged`
  // in StagedItemsPanel.
  //
  // The semantics are deliberately additive — the user can clipboard
  // a list, then upload a ranked CSV, then filter and add AniList
  // items, and the merge sort sees the union. Per-group dedup keeps
  // first-occurrence order so a sublist that's later re-introduced
  // as flat doesn't lose its rank.
  const [staged, setStaged] = useState<StagedGroup[]>([]);

  // Relabel staged AniList items live when the display preferences
  // change so items added before the toggle match items added after.
  // No-op for non-AniList groups (relabel returns the same reference).
  useEffect(() => {
    return subscribeAnilistDisplayPreferences(() => {
      setStaged((prev) => {
        let groupsChanged = false;
        const next = prev.map((group) => {
          let itemsChanged = false;
          const items = group.items.map((item) => {
            const relabelled = relabelAnilistItemPreservingFormat(item);
            if (relabelled !== item) itemsChanged = true;
            return relabelled;
          });
          if (!itemsChanged) return group;
          groupsChanged = true;
          return { ...group, items };
        });
        return groupsChanged ? next : prev;
      });
    });
  }, []);

  const appendStagedGroups = useCallback(
    (groups: StagedGroupInput[]) => {
      if (groups.length === 0) return;
      setStaged((prev) => {
        const next = [...prev];
        for (const g of groups) {
          next.push({ ...g, id: uid() } as StagedGroup);
        }
        return next;
      });
      notifyDraftActivity();
    },
    [notifyDraftActivity],
  );

  /**
   * Toggle the soft-removal flag on a staged group. Marked groups
   * stay in the panel struck-through with a ↺ undo handle; Start
   * Sort drops them for real (they're filtered by
   * `buildSortInputFromStaged`, never reach the engine). Different
   * from `clearAllStaged` which is a hard delete with no undo.
   */
  const toggleStagedGroupRemoval = useCallback((id: string) => {
    setStaged((prev) =>
      prev.map((g) =>
        g.id === id ? { ...g, markedForRemoval: !g.markedForRemoval } : g,
      ),
    );
  }, []);

  const clearAllStaged = useCallback(() => {
    setStaged([]);
  }, []);

  /**
   * Toggle the soft-removal mark on a single item inside a staged
   * group. The item stays visible in the panel struck-through with a
   * ↺ undo handle; Start Sort excludes it. The mark lives on the
   * group as a Set of item ids — keeping it per-group (rather than a
   * single flat Set across the whole panel) means the same item id
   * can be marked in one source and kept in another.
   *
   * Acts only on `staged`. Pending groups are materialised from the
   * source the user is currently editing — the StagedItemsPanel
   * hides per-item action buttons for pending rows so this callback
   * is never invoked with a pending id, but the early-return makes
   * that defence cheap if a future caller forgets.
   */
  const toggleStagedItemRemoval = useCallback(
    (groupId: string, itemId: ItemId) => {
      setStaged((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g;
          const cur = g.markedItemIds;
          const next = new Set(cur ?? []);
          if (next.has(itemId)) next.delete(itemId);
          else next.add(itemId);
          // Drop the field entirely when empty so the group's JSON
          // shape stays trim — no { markedItemIds: Set(0) } artifacts.
          if (next.size === 0) {
            const { markedItemIds: _omit, ...rest } = g;
            return rest as StagedGroup;
          }
          return { ...g, markedItemIds: next };
        }),
      );
    },
    [],
  );

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

  /**
   * Staged-item edit target. Separate from `editTarget` (which is
   * scoped to the CSV preview's row-numbered overlay) because staged
   * groups don't have a stable `(sourceName, rowNumber)` handle —
   * the source is the synthetic group id and the row index would
   * shift on any reordering. Patches from the modal mutate the
   * staged group's `items[]` in place (well, immutably — via
   * setStaged) so the changes survive into Start Sort.
   *
   * The id field is intentionally NOT editable here — re-keying a
   * staged item by id would invalidate dedup rules, marked-removal
   * sets, and any cross-group references. Label / URL / image only.
   */
  const [editStagedTarget, setEditStagedTarget] = useState<{
    groupId: string;
    itemId: ItemId;
  } | null>(null);

  /**
   * Look up the live Item for the staged edit target. Returns null
   * if the group or item disappeared between the click that opened
   * the modal and this render (concurrent re-import, etc.) — the
   * modal then renders nothing and the user can re-open it.
   */
  const editStagedItem: Item | null = useMemo(() => {
    if (!editStagedTarget) return null;
    const g = staged.find((x) => x.id === editStagedTarget.groupId);
    if (!g) return null;
    return g.items.find((it) => it.id === editStagedTarget.itemId) ?? null;
  }, [editStagedTarget, staged]);

  const openStagedEdit = useCallback(
    (groupId: string, itemId: ItemId) => {
      setEditStagedTarget({ groupId, itemId });
    },
    [],
  );

  /**
   * Apply an EditItemModal patch to the targeted staged item. Only
   * `label / url / imageUrl` are honoured — see comment on
   * `editStagedTarget` above for why `id` is locked. Empty-string
   * url / imageUrl is treated as "clear it" to match the CSV-edit
   * flow's semantics (see `EditItemModal` JSDoc).
   */
  const saveStagedEdit = useCallback(
    (patch: EditItemSavePayload) => {
      if (!editStagedTarget) return;
      const { groupId, itemId } = editStagedTarget;
      setStaged((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g;
          const nextItems = g.items.map((it) => {
            if (it.id !== itemId) return it;
            const updated: Item = { ...it };
            if (patch.label !== undefined) updated.label = patch.label;
            if (patch.url !== undefined) {
              updated.url = patch.url === '' ? undefined : patch.url;
            }
            if (patch.imageUrl !== undefined) {
              updated.imageUrl =
                patch.imageUrl === '' ? undefined : patch.imageUrl;
            }
            return updated;
          });
          return { ...g, items: nextItems };
        }),
      );
      setEditStagedTarget(null);
      notifyDraftActivity();
    },
    [editStagedTarget, notifyDraftActivity],
  );

  // -------- scratch mode --------
  const [scratchText, setScratchText] = useState('');
  const [scratchSkipHeader, setScratchSkipHeader] = useState(false);
  const [scratchOneTitlePerLine, setScratchOneTitlePerLine] = useState(false);
  // When checked, the parsed items are treated as already-sorted: skip
  // the merge sort entirely and start the slot in insertion mode with
  // an empty pending list. The user can then "+ Add items" to insert
  // new items via binary insertion. See plan §6c.
  const [scratchAlreadySorted, setScratchAlreadySorted] = useState(false);
  const scratchFileRef = useRef<HTMLInputElement | null>(null);
  const scratchDetectedHeader = useMemo(() => {
    if (!scratchText.trim()) return false;
    const parsed = Papa.parse<string[]>(scratchText, {
      ...PAPA_COMMA_CSV_OPTIONS,
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
        commaInLabel: [] as CommaInLabelWarning[],
      };
    }
    if (scratchOneTitlePerLine) {
      const rows = parseExtrasText(scratchText, 'pasted CSV');
      return {
        rows,
        detectedHeader: false,
        extraColumns: [] as ExtraColumnsWarning[],
        commaInLabel: [] as CommaInLabelWarning[],
      };
    }
    return parseCsvRows(scratchText, 'pasted CSV', scratchSkipHeader);
  }, [scratchText, scratchSkipHeader, scratchOneTitlePerLine]);

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
              commaInLabel: filterCommaInLabelForExcluded(
                scratchParsed.commaInLabel,
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

  const updateScratchOneTitlePerLine = useCallback(
    (next: boolean) => {
      setScratchOneTitlePerLine(next);
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

  function addScratchToStaged(): void {
    if (scratchResult.items.length === 0) return;
    const sourceLabel = scratchAlreadySorted
      ? 'pasted CSV (ranked)'
      : 'pasted CSV';
    const group: StagedGroupInput = scratchAlreadySorted
      ? {
          kind: 'sublist',
          source: sourceLabel,
          items: scratchResult.items,
          seedAsSortedHint: true,
        }
      : { kind: 'flat', source: sourceLabel, items: scratchResult.items };
    appendStagedGroups([group]);
    // Clear the scratch tab so the user gets a fresh slate — the
    // staged group preserves a copy of `items`. Overrides for the
    // 'pasted CSV' source are dropped too (row numbers no longer
    // mean anything once the textarea empties).
    setScratchText('');
    setScratchSkipHeader(false);
    setScratchAlreadySorted(false);
    dropSourceEdits('pasted CSV', setOverrides, setExcludedRows);
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
      ...PAPA_COMMA_CSV_OPTIONS,
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
      ...PAPA_COMMA_CSV_OPTIONS,
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
          ...PAPA_COMMA_CSV_OPTIONS,
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
        commaInLabel: filterCommaInLabelForExcluded(r.commaInLabel, excludedRows),
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
          commaInLabel: [] as CommaInLabelWarning[],
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
        commaInLabel: filterCommaInLabelForExcluded(
          extrasParsed.commaInLabel,
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
      commaInLabel: result.commaInLabel,
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
    setScratchOneTitlePerLine(false);
    setScratchAlreadySorted(false);
    setStagedFiles([]);
    setPasteText('');
    setPasteSkipHeader(false);
    setPasteError(null);
    setExtrasText('');
    setExtrasSkipHeader(false);
    setEditTarget(null);
    setStaged([]);
    // The engine choice is per-draft — a fresh draft starts back on the
    // default (merge).
    setStartMode('merge');
  }

  function draftHasContent(): boolean {
    if (staged.length > 0) return true;
    if (mode === 'scratch') return scratchText.trim().length > 0;
    if (mode === 'preranked') {
      return stagedFiles.length > 0 || extrasText.trim().length > 0;
    }
    // anilist mode contributes through "Add to staged" only — when
    // staged is empty there's no draft to adopt regardless of what's
    // in the AniList view.
    return false;
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
    return () => {
      onDraftCapabilitiesChange({
        canList: false,
        canRank: false,
        canResult: false,
        hasLosableDraft: false,
      });
    };
  }, [onDraftCapabilitiesChange]);

  // --- combined adoption (staged + current tab pending content) ---
  //
  // The header tabs (LIST/RANK/RESULT) and the panel's "Start sort"
  // both consume a single unified item set: whatever's already in
  // `staged`, plus whatever the CURRENT tab would add if the user
  // had pressed "Add to staged". This way the user can paste a CSV
  // and hit RANK directly without clicking through Add → Start.
  //
  // anilist mode's pending selection is NOT pulled in here — that
  // tab is staged-only by design (the explicit selection flow makes
  // the "what gets added" promise unambiguous when chips and
  // filters are involved).

  const currentTabPendingGroups = useCallback((): StagedGroup[] => {
    if (mode === 'scratch') {
      if (scratchResult.items.length === 0) return [];
      const sourceLabel = scratchAlreadySorted
        ? 'pasted CSV (ranked)'
        : 'pasted CSV';
      if (scratchAlreadySorted) {
        return [
          {
            kind: 'sublist',
            id: '__pending_scratch__',
            source: sourceLabel,
            items: scratchResult.items,
            seedAsSortedHint: true,
          },
        ];
      }
      return [
        {
          kind: 'flat',
          id: '__pending_scratch__',
          source: sourceLabel,
          items: scratchResult.items,
        },
      ];
    }
    if (mode === 'preranked') {
      const groups: StagedGroup[] = [];
      // Iterate perSource so each staged file keeps its own group +
      // source name, and we pick up the FULLY-MERGED Item (URL/image
      // backfilled from later sources) by looking it up in the
      // global dedup result.
      const mergedById = new Map<string, Item>(
        prerankedResult.items.map((it) => [it.id, it]),
      );
      for (const ps of prerankedResult.perSource) {
        const isExtras = ps.sourceName === 'extras';
        const items: Item[] = [];
        const seen = new Set<string>();
        for (const pi of ps.items) {
          if (seen.has(pi.item.id)) continue;
          seen.add(pi.item.id);
          items.push(mergedById.get(pi.item.id) ?? pi.item);
        }
        if (items.length === 0) continue;
        groups.push(
          isExtras
            ? {
                kind: 'flat',
                id: `__pending_preranked_${ps.sourceName}__`,
                source: ps.sourceName,
                items,
              }
            : {
                kind: 'sublist',
                id: `__pending_preranked_${ps.sourceName}__`,
                source: ps.sourceName,
                items,
              },
        );
      }
      return groups;
    }
    return [];
  }, [
    mode,
    scratchAlreadySorted,
    scratchResult,
    prerankedResult,
  ]);

  const pendingGroupsForPanel = useMemo<StagedGroup[]>(
    () => currentTabPendingGroups(),
    [currentTabPendingGroups],
  );

  const combinedGroups = useMemo<StagedGroup[]>(
    () => [...staged, ...pendingGroupsForPanel],
    [staged, pendingGroupsForPanel],
  );

  const combinedSortInput = useMemo(
    () => buildSortInputFromStaged(combinedGroups),
    [combinedGroups],
  );

  /**
   * True iff the combined draft is one already-sorted sublist with
   * no flat groups — that's the only shape that maps to the
   * `seedAsSorted` (skip-the-sort) path.
   */
  // A soft-removed sublist must NOT trip the "Use as ranking" CTA —
  // Start Sort would then route through the seed-as-sorted path with
  // a sublist that's about to be excluded. Mirrors the panel's
  // `isAlreadySortedReady` so the CTA decision stays in sync.
  const combinedAlreadySortedReady =
    combinedGroups.length === 1 &&
    combinedGroups[0].kind === 'sublist' &&
    combinedGroups[0].seedAsSortedHint === true &&
    !combinedGroups[0].markedForRemoval;

  const startFromCombined = useCallback(
    (initialTab?: TabId) => {
      if (combinedAlreadySortedReady) {
        // "Use as ranking" is its own intent (a finished ranking, no
        // comparisons) and is always insertion-engine seedAsSorted —
        // independent of the merge/insertion split-button choice.
        onStartAlreadySorted(combinedSortInput.sublists[0], initialTab);
      } else if (startMode === 'insertion') {
        onStartInsertion(
          {
            sublists: combinedSortInput.sublists,
            extras: combinedSortInput.extras,
          },
          initialTab,
        );
      } else {
        onStartPreranked(
          {
            sublists: combinedSortInput.sublists,
            extras: combinedSortInput.extras,
          },
          initialTab,
        );
      }
      // Draft was consumed into a new slot — drop staged/pending so a
      // return to START doesn't show a stale import queue.
      clearDraftState();
    },
    [
      combinedAlreadySortedReady,
      combinedSortInput,
      onStartAlreadySorted,
      onStartPreranked,
      onStartInsertion,
      startMode,
    ],
  );

  // Capabilities reflect the COMBINED draft (staged + current tab
  // pending). AniList mode's pending selection is NOT pulled in —
  // adoption while in anilist mode is staged-only. The user adds via
  // "Add to staged" inside the AniList view, then header tabs work.
  useEffect(() => {
    const hasLosableDraft = draftHasContent();
    if (combinedAlreadySortedReady) {
      // Single already-sorted sublist: RANK is meaningless (no
      // comparisons to schedule), only LIST and RESULT make sense.
      onDraftCapabilitiesChange({
        canList: combinedSortInput.uniqueCount >= 1,
        canRank: false,
        canResult: combinedSortInput.uniqueCount >= 1,
        hasLosableDraft,
      });
      return;
    }
    onDraftCapabilitiesChange({
      canList: combinedSortInput.uniqueCount >= 1,
      canRank: combinedSortInput.uniqueCount >= 2,
      canResult: false,
      hasLosableDraft,
    });
  }, [
    combinedAlreadySortedReady,
    combinedSortInput.uniqueCount,
    staged,
    mode,
    scratchText,
    stagedFiles,
    extrasText,
    onDraftCapabilitiesChange,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      tryAdoptDraft(tab: StartDraftAdoptTab): boolean {
        if (!draftHasContent()) return false;
        if (combinedAlreadySortedReady) {
          if (tab !== 'result' && tab !== 'list') return false;
          if (combinedSortInput.uniqueCount < 1) return false;
          startFromCombined(tab);
          return true;
        }
        if (tab === 'list' && combinedSortInput.uniqueCount >= 1) {
          startFromCombined('list');
          return true;
        }
        if (tab === 'rank' && combinedSortInput.uniqueCount >= 2) {
          startFromCombined('rank');
          return true;
        }
        return false;
      },
    }),
    [combinedAlreadySortedReady, combinedSortInput, startFromCombined],
  );

  function addPrerankedToStaged(): void {
    const groups = currentTabPendingGroups();
    if (groups.length === 0) return;
    // Strip the synthetic '__pending_*__' ids so appendStagedGroups
    // mints fresh ones (those ids only exist so combinedGroups can
    // key the pending preview without clashing with real staged ids).
    const toAppend = groups.map((g) => {
      const { id: _omit, ...rest } = g;
      return rest as StagedGroupInput;
    });
    appendStagedGroups(toAppend);
    // Clear the preranked tab — staged files + extras textarea + any
    // overrides tied to those sources.
    for (const f of stagedFiles) {
      dropSourceEdits(f.name, setOverrides, setExcludedRows);
    }
    dropSourceEdits('extras', setOverrides, setExcludedRows);
    setStagedFiles([]);
    setExtrasText('');
    setExtrasSkipHeader(false);
    setPasteText('');
    setPasteSkipHeader(false);
  }

  const onAddAnilistToStaged = useCallback(
    (items: Item[], sourceLabel: string) => {
      if (items.length === 0) return;
      appendStagedGroups([
        { kind: 'flat', source: sourceLabel, items },
      ]);
    },
    [appendStagedGroups],
  );

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
            One item per row. Format: <code>ITEM, URL (optional), IMAGE (optional)</code>.
            Pasting a plain title list from clipboard? Check &quot;One title per line&quot;
            below so commas stay part of the title.
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
              id="scratch-one-per-line"
              type="checkbox"
              checked={scratchOneTitlePerLine}
              onChange={(e) => updateScratchOneTitlePerLine(e.target.checked)}
            />
            <label htmlFor="scratch-one-per-line">
              One title per line (commas are part of the title)
            </label>
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
            commaInLabel={scratchResult.commaInLabel}
            startLabel={`Add to staged (${scratchResult.items.length} item${scratchResult.items.length === 1 ? '' : 's'})`}
            startDisabled={scratchResult.items.length < 1}
            onStart={addScratchToStaged}
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
            commaInLabel={prerankedResult.commaInLabel}
            sublistCount={prerankedResult.sublists.length}
            singletonCount={prerankedResult.extras.length}
            startLabel={`Add to staged (${prerankedResult.items.length} item${prerankedResult.items.length === 1 ? '' : 's'})`}
            startDisabled={prerankedResult.items.length < 1}
            onStart={addPrerankedToStaged}
            onEditOccurrence={onEditOccurrencePreranked}
            onRemoveRow={onRemovePreviewRowPreranked}
          />
        </div>
      )}

      {mode === 'anilist' && (
        <AnilistStartMode
          onAddToStaged={onAddAnilistToStaged}
          onDraftActivity={notifyDraftActivity}
          dbSyncRevision={dbSyncRevision}
        />
      )}

      <StagedItemsPanel
        staged={staged}
        pending={pendingGroupsForPanel}
        onToggleRemoveGroup={toggleStagedGroupRemoval}
        onToggleRemoveItem={toggleStagedItemRemoval}
        onEditItem={openStagedEdit}
        onClearAll={clearAllStaged}
        onStartSort={() => startFromCombined()}
        onStartAlreadySorted={() => startFromCombined()}
        startMode={startMode}
        onStartModeChange={setStartMode}
      />

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

      {/* Staged-item edit modal. Same component as the CSV preview's
          edit flow but `allowEditId` is OFF — renaming a staged
          item's id would break dedup, marked-removal sets, and any
          cross-group references built up in the panel state. The
          user can still edit label / url / imageUrl which covers the
          common typo-fix use case the modal was designed for. */}
      {editStagedItem && editStagedTarget && (
        <EditItemModal
          item={editStagedItem}
          onCancel={() => setEditStagedTarget(null)}
          onSave={saveStagedEdit}
        />
      )}
    </div>
  );
});
