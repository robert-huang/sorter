import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import type { Item } from '../lib/types';
import {
  canonicalKey,
  looksLikeHeader,
  parseCsvRows,
  parseSources,
  PAPA_COMMA_CSV_OPTIONS,
} from '../lib/csv';
import { AnilistStartMode } from './AnilistStartMode';
import { CircularArrowGlyph } from './CircularArrowGlyph';
import { InfoIcon } from './icons';
import { Modal } from './Modal';
import { SortResultsImportMode } from './SortResultsImportMode';
import type { OrderedSlotImport } from './SortResultsImportMode';
import type { SlotResultsImportBatch } from '../lib/completedSortEditH';
import {
  cachedAnilistSourceKey,
  cachedAnilistSourcesForUsername,
  cachedAnilistSourceTypeLabel,
  listCachedAnilistSources,
  materializeCachedAnilistSource,
  type CachedAnilistSourceSummary,
} from '../lib/importers/anilist/anilistItemMaterialization';
import {
  hydrateItemsFromExactAnilistNames,
  type AnilistHydrationResult,
} from '../lib/importers/anilist/anilistPlaintextHydration';
import { readLastAnilistUsername } from '../lib/importers/anilist/lastUsername';
import {
  runAnilistFavourites,
  runAnilistImport,
} from '../lib/importers/anilist/runners';
import { isGraphTimestampStale } from '../lib/importers/anilist/graphConstants';
import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';
import { formatAnilistProgress } from './anilistProgressLabel';

/**
 * Unified "Add item(s)" modal. Four tabs:
 *  - "Single"  — label + URL + image fields (one item).
 *  - "Multiple" — CSV paste + file upload (N items at once).
 *  - "AniList" — import from a user's list or favourites cache.
 *  - "Results" — import final rankings from local save slots.
 *
 * On the merge engine, the Multiple tab also offers a checkbox:
 *  "Treat as one pre-ranked sublist". When checked, the items append as
 *  ONE ranked sublist to the back of the queue (route to onAppendPreRanked).
 *  When unchecked, each item becomes its own singleton sublist
 *  (route to onAddMany). On the insertion engine the checkbox is hidden
 *  because there is no pre-ranked concept — pending is FIFO either way.
 */
export type AddItemsModalTab =
  | 'single'
  | 'multiple'
  | 'anilist'
  | 'sortresults';

export const ADD_ITEMS_LAST_TAB_LS_KEY = 'sorter:add-items:lastTab';

function isAddItemsModalTab(value: string | null): value is AddItemsModalTab {
  return (
    value === 'single' ||
    value === 'multiple' ||
    value === 'anilist' ||
    value === 'sortresults'
  );
}

function readLastAddItemsTab(): AddItemsModalTab {
  try {
    const stored = localStorage.getItem(ADD_ITEMS_LAST_TAB_LS_KEY);
    return isAddItemsModalTab(stored) ? stored : 'single';
  } catch {
    return 'single';
  }
}

function writeLastAddItemsTab(tab: AddItemsModalTab): void {
  try {
    localStorage.setItem(ADD_ITEMS_LAST_TAB_LS_KEY, tab);
  } catch {
    /* Ignore unavailable storage; the mounted modal still retains its tab. */
  }
}

interface Props {
  engine: 'merge' | 'insertion' | 'confirmation';
  existingIds: Set<string>;
  /** Hidden ids with metadata — add will reinsert, not hard-skip. */
  hiddenRestoreIds: Set<string>;
  /** Omit from Sort results picker (active slot). */
  excludeSlotId?: string;
  /** Bumps when the AniList source DB changes (import, pull, etc.). */
  dbSyncRevision: number;
  /** Hosts such as Bump Chart always preserve imported list order. */
  forcePreRanked?: boolean;
  /** Hosts such as Bump Chart can sort and search browser-save results. */
  showBrowserSaveSortControls?: boolean;
  /** Tab selected when the modal opens. Defaults to the last-used tab. */
  initialTab?: AddItemsModalTab;
  /** Lets a host remember the selected tab after the modal closes. */
  onTabChange?: (tab: AddItemsModalTab) => void;
  onCancel: () => void;
  /** Single tab → add one item (skipped automatically if id collides). */
  onAddOne: (item: Item) => void;
  /** Multiple tab, unranked → each item becomes its own singleton. */
  onAddMany: (items: Item[]) => void;
  /**
   * Multiple tab, "treat as pre-ranked sublist" checked. Merge engine only;
   * may be omitted when the modal opens on the insertion engine.
   */
  onAddPreRanked?: (items: Item[]) => void;
  /** Results tab — one batch per selected slot, applied in a single update. */
  onAddSlotImports?: (batches: SlotResultsImportBatch[]) => void;
  /** Consumers that need each completed slot's display title and ordering. */
  onImportOrderedItems?: (imports: OrderedSlotImport[]) => void;
  /** Bump Chart shortcut: import each selected slot as a new trailing order. */
  onImportOrderedItemsAsNewOrders?: (imports: OrderedSlotImport[]) => void;
}

export function AddItemsModal({
  engine,
  existingIds,
  hiddenRestoreIds,
  excludeSlotId,
  dbSyncRevision,
  forcePreRanked = false,
  showBrowserSaveSortControls = false,
  initialTab,
  onTabChange,
  onCancel,
  onAddOne,
  onAddMany,
  onAddPreRanked,
  onAddSlotImports,
  onImportOrderedItems,
  onImportOrderedItemsAsNewOrders,
}: Props) {
  const [tab, setTab] = useState<AddItemsModalTab>(
    () => initialTab ?? readLastAddItemsTab(),
  );

  useEffect(() => {
    writeLastAddItemsTab(tab);
  }, [tab]);

  const selectTab = (nextTab: AddItemsModalTab): void => {
    setTab(nextTab);
    onTabChange?.(nextTab);
  };

  const modalClassName = [
    'modal-wide',
    tab === 'anilist' ? 'modal-wide-anilist' : '',
    tab === 'sortresults' ? 'modal-wide-sort-results' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Modal
      label={`Add item${tab === 'multiple' ? 's' : ''}`}
      onClose={onCancel}
      className={modalClassName}
    >
      <h3>Add item{tab === 'multiple' ? 's' : ''}</h3>
      <div className="modal-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'single'}
          className={`modal-tab${tab === 'single' ? ' active' : ''}`}
          onClick={() => selectTab('single')}
        >
          Single
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'multiple'}
          className={`modal-tab${tab === 'multiple' ? ' active' : ''}`}
          onClick={() => selectTab('multiple')}
        >
          Multiple
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'anilist'}
          className={`modal-tab${tab === 'anilist' ? ' active' : ''}`}
          onClick={() => selectTab('anilist')}
        >
          AniList
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'sortresults'}
          className={`modal-tab${tab === 'sortresults' ? ' active' : ''}`}
          onClick={() => selectTab('sortresults')}
        >
          Results
        </button>
      </div>

      {tab === 'single' && (
        <SingleTab
          existingIds={existingIds}
          hiddenRestoreIds={hiddenRestoreIds}
          engine={engine}
          dbSyncRevision={dbSyncRevision}
          onCancel={onCancel}
          onAdd={onAddOne}
        />
      )}
      {tab === 'multiple' && (
        <MultipleTab
          engine={engine}
          forcePreRanked={forcePreRanked}
          existingIds={existingIds}
          hiddenRestoreIds={hiddenRestoreIds}
          dbSyncRevision={dbSyncRevision}
          onCancel={onCancel}
          onAddMany={onAddMany}
          onAddPreRanked={onAddPreRanked}
        />
      )}
      {tab === 'anilist' && (
        <AnilistStartMode
          embedded
          dbSyncRevision={dbSyncRevision}
          existingIds={existingIds}
          hiddenRestoreIds={hiddenRestoreIds}
          onAddItems={(items) => {
            onAddMany(items);
            onCancel();
          }}
        />
      )}
      {tab === 'sortresults' && (
        onImportOrderedItems ? (
          <SortResultsImportMode
            embedded
            excludeSlotId={excludeSlotId}
            existingIds={existingIds}
            hiddenRestoreIds={hiddenRestoreIds}
            showPreRankedToggle={!forcePreRanked}
            showBrowserSortControls={showBrowserSaveSortControls}
            onImportOrderedItems={onImportOrderedItems}
            onImportOrderedItemsAsNewOrders={
              onImportOrderedItemsAsNewOrders
            }
            onComplete={onCancel}
          />
        ) : (
          <SortResultsImportMode
            embedded
            excludeSlotId={excludeSlotId}
            existingIds={existingIds}
            hiddenRestoreIds={hiddenRestoreIds}
            showPreRankedToggle={!forcePreRanked}
            showBrowserSortControls={showBrowserSaveSortControls}
            onAddSlotImports={onAddSlotImports!}
            onComplete={onCancel}
          />
        )
      )}
    </Modal>
  );
}

// ============================================================================
// Single tab — same form as the legacy AddItemModal
// ============================================================================

function isActiveSortDuplicate(
  id: string,
  existingIds: Set<string>,
  hiddenRestoreIds: Set<string>,
): boolean {
  return existingIds.has(id) && !hiddenRestoreIds.has(id);
}

function SingleTab({
  existingIds,
  hiddenRestoreIds,
  engine,
  dbSyncRevision,
  onCancel,
  onAdd,
}: {
  existingIds: Set<string>;
  hiddenRestoreIds: Set<string>;
  engine: 'merge' | 'insertion' | 'confirmation';
  dbSyncRevision: number;
  onCancel: () => void;
  onAdd: (item: Item) => void;
}) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hydratedItem, setHydratedItem] = useState<Item | null>(null);

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Label is required.');
      return;
    }
    const id = hydratedItem?.id ?? canonicalKey(trimmed);
    if (isActiveSortDuplicate(id, existingIds, hiddenRestoreIds)) {
      setError('An item with this label is already in the sort.');
      return;
    }
    onAdd(
      hydratedItem
        ? {
            ...hydratedItem,
            label: trimmed,
            url: url.trim() || undefined,
            imageUrl: imageUrl.trim() || undefined,
          }
        : {
            id,
            label: trimmed,
            url: url.trim() || undefined,
            imageUrl: imageUrl.trim() || undefined,
          },
    );
  }

  const willRestore =
    label.trim().length > 0 &&
    hiddenRestoreIds.has(hydratedItem?.id ?? canonicalKey(label.trim()));

  const hint =
    engine === 'insertion'
      ? 'New item is appended to the pending list and binary-inserted into the ranking.'
      : 'New item is appended to the back of the queue and merged into the existing ranking.';

  return (
    <form onSubmit={onSubmit}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        {willRestore
          ? 'This label matches a hidden item — adding will reinsert it into the sort.'
          : hint}
      </p>
      <div className="form-row">
        <label htmlFor="add-label">Label *</label>
        <input
          id="add-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
      </div>
      <div className="form-row">
        <label htmlFor="add-url">URL (optional)</label>
        <input
          id="add-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
      <div className="form-row">
        <label htmlFor="add-image">Image URL (optional)</label>
        <input
          id="add-image"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
      <AnilistHydrationControls
        items={
          label.trim()
            ? [
                {
                  id: canonicalKey(label.trim()),
                  label: label.trim(),
                  url: url.trim() || undefined,
                  imageUrl: imageUrl.trim() || undefined,
                },
              ]
            : []
        }
        dbSyncRevision={dbSyncRevision}
        onHydrated={(result) => {
          const item = result.items[0];
          if (!item || result.matchedCount === 0) {
            setHydratedItem(null);
            return;
          }
          setHydratedItem(item);
          setLabel(item.label);
          setUrl(item.url ?? '');
          setImageUrl(item.imageUrl ?? '');
          setError(null);
        }}
      />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary">
          Add
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// Multiple tab — CSV paste / file, optional "preserve order as one sublist"
// ============================================================================

function MultipleTab({
  engine,
  forcePreRanked,
  existingIds,
  hiddenRestoreIds,
  dbSyncRevision,
  onCancel,
  onAddMany,
  onAddPreRanked,
}: {
  engine: 'merge' | 'insertion' | 'confirmation';
  forcePreRanked: boolean;
  existingIds: Set<string>;
  hiddenRestoreIds: Set<string>;
  dbSyncRevision: number;
  onCancel: () => void;
  onAddMany: (items: Item[]) => void;
  onAddPreRanked?: (items: Item[]) => void;
}) {
  const [text, setText] = useState('');
  const [skipHeader, setSkipHeader] = useState(false);
  // Merge-engine only: when checked, send the items through the
  // pre-ranked path (one sublist preserving order); when unchecked,
  // they go through addItems (N singletons). For insertion engine,
  // pending is FIFO either way so the checkbox is hidden.
  const [asPreRanked, setAsPreRanked] = useState(false);
  const [hydratedItems, setHydratedItems] = useState<Item[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => setText(t));
    e.target.value = '';
  }

  const detectedHeader = useMemo(() => {
    if (!text.trim()) return false;
    const parsed = Papa.parse<string[]>(text, {
      ...PAPA_COMMA_CSV_OPTIONS,
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [text]);

  const parsed = useMemo(() => {
    if (!text.trim()) return { items: [] as Item[] };
    const rows = parseCsvRows(text, 'add items', skipHeader);
    const r = parseSources([
      {
        sourceName: 'add items',
        rawRows: rows.rows,
        detectedHeader: rows.detectedHeader,
      },
    ]);
    return { items: r.items };
  }, [text, skipHeader]);

  useEffect(() => {
    setHydratedItems(null);
  }, [text, skipHeader]);

  const effectiveItems = hydratedItems ?? parsed.items;

  const importSummary = useMemo(() => {
    const n = parsed.items.length;
    if (n === 0) return null;
    let restore = 0;
    let skip = 0;
    for (const it of effectiveItems) {
      if (hiddenRestoreIds.has(it.id)) restore += 1;
      else if (isActiveSortDuplicate(it.id, existingIds, hiddenRestoreIds)) {
        skip += 1;
      }
    }
    const parts = [`Parsed ${n} item${n === 1 ? '' : 's'}.`];
    if (restore > 0) {
      parts.push(
        `${restore} hidden — will reinsert.`,
      );
    }
    if (skip > 0) {
      parts.push(`${skip} already in sort — will skip.`);
    }
    return parts.join(' ');
  }, [effectiveItems, existingIds, hiddenRestoreIds]);

  function onSubmit(): void {
    if (effectiveItems.length === 0) return;
    if (
      engine === 'merge' &&
      (forcePreRanked || asPreRanked) &&
      onAddPreRanked
    ) {
      onAddPreRanked(effectiveItems);
    } else {
      onAddMany(effectiveItems);
    }
  }

  // Submit-button caption mirrors what'll actually happen.
  const submitLabel = (() => {
    const n = effectiveItems.length;
    if (n === 0) return 'Add items';
    if (
      engine === 'merge' &&
      (forcePreRanked || asPreRanked) &&
      onAddPreRanked
    ) {
      return `Add ${n} as pre-ranked sublist`;
    }
    return `Add ${n} item${n === 1 ? '' : 's'}`;
  })();

  const showPreRankedCheckbox =
    !forcePreRanked &&
    engine === 'merge' &&
    typeof onAddPreRanked === 'function';

  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        Paste a CSV or load a file. One item per row, format{' '}
        <code>ITEM, URL (optional), IMAGE (optional)</code>. Items already in
        the active sort are skipped; hidden items are reinserted.
      </p>
      <textarea
        className="csv-textarea"
        placeholder={`Inception\nHeat\nThe Matrix`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className="btn"
          onClick={() => fileRef.current?.click()}
        >
          Load CSV file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          style={{ display: 'none' }}
          onChange={onFile}
        />
      </div>
      <AnilistHydrationControls
        items={parsed.items}
        dbSyncRevision={dbSyncRevision}
        onHydrated={(result) => setHydratedItems(result.items)}
      />
      <div className="checkbox-row">
        <input
          id="multi-header"
          type="checkbox"
          checked={skipHeader}
          onChange={(e) => setSkipHeader(e.target.checked)}
        />
        <label htmlFor="multi-header">First row is a header</label>
        {detectedHeader && !skipHeader && (
          <span className="header-hint header-hint-icon">
            <InfoIcon size={13} />
            Looks like a header. Check to skip.
          </span>
        )}
      </div>

      {showPreRankedCheckbox && (
        <div className="checkbox-row">
          <input
            id="multi-preranked"
            type="checkbox"
            checked={asPreRanked}
            onChange={(e) => setAsPreRanked(e.target.checked)}
          />
          <label htmlFor="multi-preranked">
            Treat as one pre-ranked sublist (preserve order)
          </label>
          <span className="header-hint">
            {asPreRanked
              ? 'Items merge as a single sorted sublist at the back of the queue.'
              : 'Each item becomes its own singleton sublist.'}
          </span>
        </div>
      )}

      {engine === 'insertion' && (
        <p className="header-hint" style={{ marginTop: 8 }}>
          Pre-ranked sublists are a merge-engine feature. On insertion, each
          item is queued individually in paste order.
        </p>
      )}

      <div
        style={{
          marginTop: 12,
          fontSize: 13,
          color: 'var(--text-muted)',
        }}
      >
        {importSummary ?? 'No items parsed yet.'}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={onSubmit}
          disabled={effectiveItems.length === 0}
        >
          {submitLabel}
        </button>
      </div>
    </>
  );
}

function hydrationIssueLabel(reason: string): string {
  if (reason === 'ambiguous_alias') return 'matches multiple cached items';
  if (reason === 'duplicate_candidate') {
    return 'duplicates another row for the same cached item';
  }
  return 'has no exact cached match';
}

function cachedSourceRefreshTooltip(
  source: CachedAnilistSourceSummary | undefined,
): string {
  if (!source) return 'Select a cached list to refresh';
  const refreshed =
    source.refreshedAt === null
      ? 'never'
      : new Date(source.refreshedAt).toLocaleString();
  return `Refresh ${cachedAnilistSourceTypeLabel(source.source)} from AniList. Last refreshed: ${refreshed}`;
}

export function AnilistHydrationControls({
  items,
  dbSyncRevision,
  onHydrated,
}: {
  items: Item[];
  dbSyncRevision: number;
  onHydrated: (result: AnilistHydrationResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<CachedAnilistSourceSummary[] | null>(
    null,
  );
  const [username, setUsername] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] =
    useState<AnilistProgressEvent | null>(null);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnilistHydrationResult | null>(null);

  useEffect(() => {
    if (items.length > 0) return;
    setOpen(false);
    setResult(null);
    setError(null);
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void listCachedAnilistSources()
      .then((next) => {
        if (cancelled) return;
        setSources(next);
        setUsername(readLastAnilistUsername());
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSources([]);
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not read the AniList cache.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, dbSyncRevision, sourceRevision]);

  const matchingSources = useMemo(() => {
    return cachedAnilistSourcesForUsername(sources ?? [], username);
  }, [sources, username]);

  useEffect(() => {
    setSelectedKey((current) => {
      if (
        matchingSources.some(
          ({ source }) => cachedAnilistSourceKey(source) === current,
        )
      ) {
        return current;
      }
      return matchingSources[0]
        ? cachedAnilistSourceKey(matchingSources[0].source)
        : '';
    });
    setResult(null);
  }, [matchingSources]);

  const selectedSource = matchingSources.find(
    ({ source }) => cachedAnilistSourceKey(source) === selectedKey,
  );
  const selectedSourceIsStale =
    selectedSource !== undefined &&
    (selectedSource.refreshedAt === null ||
      isGraphTimestampStale(selectedSource.refreshedAt));
  const busy = loading || refreshing;

  async function hydrate(): Promise<void> {
    if (!selectedSource || items.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const candidates = await materializeCachedAnilistSource(
        selectedSource.source,
      );
      const next = hydrateItemsFromExactAnilistNames(items, candidates);
      setResult(next);
      onHydrated(next);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Could not hydrate these items.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function refreshSelectedSource(): Promise<void> {
    if (!selectedSource) return;
    setRefreshing(true);
    setRefreshProgress(null);
    setError(null);
    setResult(null);
    try {
      const { source } = selectedSource;
      if (source.kind === 'list') {
        await runAnilistImport(
          source.userName,
          source.type,
          setRefreshProgress,
        );
      } else {
        await runAnilistFavourites(
          source.userName,
          source.type,
          setRefreshProgress,
        );
      }
      setSourceRevision((current) => current + 1);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not refresh this AniList source.',
      );
    } finally {
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }

  return (
    <div className="anilist-hydration">
      <button
        type="button"
        className="btn btn-sm"
        disabled={items.length === 0}
        title="Match item names exactly against a cached AniList source to add canonical IDs, links, images, and metadata.&#013;&#013;Unmatched or ambiguous items stay unchanged."
        onClick={() => setOpen((current) => !current)}
      >
        Hydrate from cached AniList list…
      </button>
      {open && (
        <div className="anilist-hydration-panel">
          {sources === null ? (
            <span className="header-hint">Reading AniList cache…</span>
          ) : sources.length === 0 ? (
            <span className="header-hint">
              No cached AniList sources found.
            </span>
          ) : (
            <>
              <div className="anilist-hydration-fields">
                <label>
                  <span>AniList username</span>
                  <input
                    type="text"
                    value={username}
                    disabled={busy}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      setError(null);
                    }}
                    placeholder="AniList username"
                    autoComplete="off"
                  />
                </label>
                <div className="anilist-hydration-source-field">
                  <label>
                    <span>Cached list</span>
                    <span className="anilist-hydration-select">
                      <select
                        value={selectedKey}
                        disabled={busy || matchingSources.length === 0}
                        onChange={(event) => {
                          setSelectedKey(event.target.value);
                          setResult(null);
                        }}
                      >
                        {matchingSources.length === 0 && (
                          <option value="">
                            {username.trim()
                              ? 'No cached lists for this username'
                              : 'Enter a username first'}
                          </option>
                        )}
                        {matchingSources.map(({ source, count }) => (
                          <option
                            key={cachedAnilistSourceKey(source)}
                            value={cachedAnilistSourceKey(source)}
                          >
                            {cachedAnilistSourceTypeLabel(source)} ({count})
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <button
                    type="button"
                    className={`btn anilist-hydration-refresh${selectedSourceIsStale ? ' is-stale' : ''}${refreshing ? ' is-refreshing' : ''}`}
                    disabled={busy || !selectedSource}
                    title={cachedSourceRefreshTooltip(selectedSource)}
                    aria-label={cachedSourceRefreshTooltip(selectedSource)}
                    onClick={() => void refreshSelectedSource()}
                  >
                    <CircularArrowGlyph />
                  </button>
                </div>
                {refreshing && (
                  <span
                    className="anilist-hydration-progress"
                    role="status"
                    aria-live="polite"
                  >
                    {refreshProgress
                      ? formatAnilistProgress(refreshProgress)
                      : 'Connecting to AniList…'}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn anilist-hydration-match"
                disabled={busy || !selectedSource || selectedSource.count === 0}
                onClick={() => void hydrate()}
              >
                {loading ? 'Hydrating…' : 'Match exact names'}
              </button>
            </>
          )}
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      {result && (
        <div className="header-hint anilist-hydration-result">
          Matched {result.matchedCount} of {result.items.length}.
          {result.items.length > result.matchedCount
            ? ' Unresolved rows remain manual and can be edited in staging.'
            : ''}
          {result.issues.length > 0 && (
            <ul>
              {result.issues.slice(0, 10).map((issue) => (
                <li key={`${issue.index}:${issue.label}`}>
                  “{issue.label}” {hydrationIssueLabel(issue.reason)}
                </li>
              ))}
              {result.issues.length > 10 && (
                <li>…and {result.issues.length - 10} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
