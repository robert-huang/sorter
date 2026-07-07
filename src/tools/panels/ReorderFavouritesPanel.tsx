import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ANILIST_ACCOUNTS_CHANGED,
  findAnilistAccountByName,
} from '../../lib/importers/anilist/anilistAuth';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { buildAnilistFavouriteUrl } from '../../lib/importers/anilist/anilistSource';
import {
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { Modal } from '../../components/Modal';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import {
  loadFavouritesFresh,
  saveFavouriteOrder,
  unfavouriteItems,
} from './reorderFavouritesApi';
import {
  applySelectRankOrder,
  appendRecentlyDeleted,
  DEFAULT_REORDER_FAVOURITES_FORM,
  dragInsertIndexFromDomPoint,
  dragPayloadIds,
  EMPTY_SELECT_RANK_STATE,
  favouriteIdsInOrder,
  handleSelectRankClick,
  hasPendingReorderChanges,
  hasSelectRankChanges,
  itemsWithSortOrder,
  loadRecentlyDeletedBuckets,
  REORDER_FAVOURITE_TYPE_OPTIONS,
  reorderByDrag,
  reorderByDragDisplayPreview,
  relabelFavouriteListItems,
  revertItemsToIdOrder,
  sameIdOrder,
  selectRankLabelForItem,
  toggleSelectedId,
  wouldSelectRankChangeOrder,
  type FavouriteListItem,
  type RecentlyDeletedBucket,
  type ReorderFavouritesForm,
  type ReorderInteractionMode,
  type SelectRankState,
  type DragChipRect,
} from './reorderFavouritesLogic';

const SELECT_TO_ORDER_TOOLTIP =
  'Click chips to assign rank 1, 2, 3… Click again to clear. Shift+click from the last-clicked chip: forwards rises in list order; backwards rises going left (e.g. click C, shift+click A → C4 B5 A6). No-op if another numbered chip is in the range.';

type DragPreviewState = {
  draggedIds: number[];
  insertIndex: number;
};

type DragPointerState = {
  x: number;
  y: number;
};

const DRAG_START_THRESHOLD_PX = 4;

const LS_KEY = 'anime-tools-reorder-favourites-form';

const FIELD_IDS = {
  username: 'reorder-favourites-username',
  favouriteType: 'reorder-favourites-type',
} as const;

type PersistedForm = Pick<ReorderFavouritesForm, 'username' | 'favouriteType'>;

function loadForm(): ReorderFavouritesForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedForm>;
      return {
        ...DEFAULT_REORDER_FAVOURITES_FORM,
        username: withLastAnilistUsername(parsed.username ?? ''),
        favouriteType: parsed.favouriteType ?? DEFAULT_REORDER_FAVOURITES_FORM.favouriteType,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    ...DEFAULT_REORDER_FAVOURITES_FORM,
    username: withLastAnilistUsername(''),
  };
}

function saveForm(form: ReorderFavouritesForm): void {
  try {
    const persisted: PersistedForm = {
      username: form.username,
      favouriteType: form.favouriteType,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
}

function authHintForUsername(username: string): string | null {
  const handle = username.trim();
  if (!handle) {
    return null;
  }
  const account = findAnilistAccountByName(handle);
  if (!account) {
    return 'Not signed in — gear → Databases → Sign in to AniList (required to save or delete).';
  }
  if (account.status !== 'ok') {
    return `Sign-in expired for @${account.userName} — sign in again.`;
  }
  return `Signed in as @${account.userName}.`;
}

function filterRecentlyDeleted(
  buckets: RecentlyDeletedBucket[],
  form: ReorderFavouritesForm,
): RecentlyDeletedBucket[] {
  const username = form.username.trim().toLowerCase();
  return buckets.filter(
    (bucket) =>
      bucket.username.toLowerCase() === username &&
      bucket.favouriteType === form.favouriteType,
  );
}

export function ReorderFavouritesPanel(_props: ToolPanelProps) {
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<ReorderFavouritesForm>(() => loadForm());
  const [items, setItems] = useState<FavouriteListItem[]>([]);
  const [savedIds, setSavedIds] = useState<number[]>([]);
  const [anilistUserId, setAnilistUserId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [mode, setMode] = useState<ReorderInteractionMode>('drag');
  const [selectRankState, setSelectRankState] = useState<SelectRankState>(
    EMPTY_SELECT_RANK_STATE,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [dragPointer, setDragPointer] = useState<DragPointerState | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [recentlyDeleted, setRecentlyDeleted] = useState<RecentlyDeletedBucket[]>(() =>
    loadRecentlyDeletedBuckets(),
  );
  const [authRevision, setAuthRevision] = useState(0);
  const dragIdsRef = useRef<number[]>([]);
  const loadAbortRef = useRef<AbortController | null>(null);
  const gridRef = useRef<HTMLOListElement | null>(null);
  const dragHitRectsRef = useRef<DragChipRect[]>([]);
  const itemsRef = useRef(items);
  const selectedRef = useRef(selected);
  const dragSessionRef = useRef<DragPreviewState | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const pointerDragChipRef = useRef<HTMLLIElement | null>(null);
  const pointerDragIdRef = useRef<number | null>(null);
  const pointerDragActiveRef = useRef(false);
  const pointerDownItemIdRef = useRef<number | null>(null);
  const modeRef = useRef(mode);
  itemsRef.current = items;
  selectedRef.current = selected;
  modeRef.current = mode;

  const clearPointerDragListeners = useCallback(() => {
    pointerDragCleanupRef.current?.();
    pointerDragCleanupRef.current = null;
  }, []);

  const updateDragInsertIndex = useCallback((insertIndex: number) => {
    const session = dragSessionRef.current;
    if (session && session.insertIndex === insertIndex) {
      return;
    }
    if (session) {
      dragSessionRef.current = {
        draggedIds: session.draggedIds,
        insertIndex,
      };
    }
    setDragPreview((prev) => {
      if (!prev || prev.insertIndex === insertIndex) {
        return prev;
      }
      return {
        draggedIds: prev.draggedIds,
        insertIndex,
      };
    });
  }, []);

  const chipRectsFromGrid = useCallback((excludedIds: ReadonlySet<number>): DragChipRect[] => {
    const grid = gridRef.current;
    if (!grid) {
      return [];
    }
    return Array.from(
      grid.querySelectorAll<HTMLElement>('.tool-reorder-favourites-chip[data-item-id]'),
    )
      .filter((el) => !excludedIds.has(Number(el.dataset.itemId)))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          id: Number(el.dataset.itemId),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      });
  }, []);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    setRecentlyDeleted(filterRecentlyDeleted(loadRecentlyDeletedBuckets(), form));
  }, [form.username, form.favouriteType]);

  useEffect(() => {
    const onAccountsChanged = (): void => {
      setAuthRevision((n) => n + 1);
    };
    window.addEventListener(ANILIST_ACCOUNTS_CHANGED, onAccountsChanged);
    return () => {
      window.removeEventListener(ANILIST_ACCOUNTS_CHANGED, onAccountsChanged);
    };
  }, []);

  const authHint = useMemo(
    () => authHintForUsername(form.username),
    [form.username, authRevision],
  );

  const currentIds = useMemo(() => favouriteIdsInOrder(items), [items]);
  const isDirty = items.length > 0 && !sameIdOrder(savedIds, currentIds);
  const hasPendingChanges = useMemo(
    () => hasPendingReorderChanges(items, savedIds, selectRankState, selected, mode),
    [items, savedIds, selectRankState, selected, mode],
  );
  const canSave = useMemo(() => {
    if (anilistUserId == null || items.length === 0) {
      return false;
    }
    if (mode === 'select-rank') {
      return hasSelectRankChanges(selectRankState);
    }
    return isDirty;
  }, [anilistUserId, isDirty, items.length, mode, selectRankState]);
  const showUnsavedHint =
    isDirty || (mode === 'select-rank' && wouldSelectRankChangeOrder(items, savedIds, selectRankState));
  const selectedCount = selected.size;
  const draggedIdSet = useMemo(
    () => new Set(dragPreview?.draggedIds ?? []),
    [dragPreview?.draggedIds],
  );
  const labeledItems = useMemo(
    () => relabelFavouriteListItems(items),
    [displayLabelRevision, items],
  );

  const dragGhostItem = useMemo(() => {
    if (!dragPreview || dragPreview.draggedIds.length === 0) {
      return null;
    }
    const leadId = dragPreview.draggedIds[0]!;
    return labeledItems.find((item) => item.id === leadId) ?? null;
  }, [dragPreview, labeledItems]);

  const displayItems = useMemo(() => {
    if (mode !== 'drag' || !dragPreview) {
      return labeledItems;
    }
    return reorderByDragDisplayPreview(
      labeledItems,
      dragPreview.draggedIds,
      dragPreview.insertIndex,
    );
  }, [dragPreview, labeledItems, mode]);

  const updateInsertIndexFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const session = dragSessionRef.current;
      if (!session) {
        return;
      }
      updateDragInsertIndex(
        dragInsertIndexFromDomPoint(
          itemsRef.current,
          gridRef.current,
          clientX,
          clientY,
          new Set(session.draggedIds),
        ),
      );
    },
    [updateDragInsertIndex],
  );

  const finishPointerDrag = useCallback(
    (commit: boolean) => {
      clearPointerDragListeners();
      const chip = pointerDragChipRef.current;
      const pointerId = pointerDragIdRef.current;
      if (chip && pointerId != null) {
        try {
          chip.releasePointerCapture(pointerId);
        } catch {
          /* capture may already be released */
        }
      }
      pointerDragChipRef.current = null;
      pointerDragIdRef.current = null;
      pointerDragActiveRef.current = false;

      const session = dragSessionRef.current;
      if (commit && session && modeRef.current === 'drag') {
        setItems((prev) =>
          itemsWithSortOrder(
            reorderByDrag(prev, session.draggedIds, session.insertIndex),
          ),
        );
      }
      dragIdsRef.current = [];
      dragHitRectsRef.current = [];
      dragSessionRef.current = null;
      setDragPreview(null);
      setDragPointer(null);
    },
    [clearPointerDragListeners],
  );

  useEffect(() => () => clearPointerDragListeners(), [clearPointerDragListeners]);

  const patchForm = useCallback((patch: Partial<ReorderFavouritesForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetInteraction = useCallback(() => {
    clearPointerDragListeners();
    dragSessionRef.current = null;
    setSelected(new Set());
    setSelectRankState(EMPTY_SELECT_RANK_STATE);
    setDragPreview(null);
    setDragPointer(null);
    dragHitRectsRef.current = [];
  }, [clearPointerDragListeners]);

  const applyLoadedItems = useCallback((loaded: FavouriteListItem[]) => {
    const ordered = itemsWithSortOrder(loaded);
    setItems(ordered);
    setSavedIds(favouriteIdsInOrder(ordered));
    resetInteraction();
  }, [resetInteraction]);

  const onLoad = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      setLoading(true);
      setError(null);
      setSuccess(null);
      setLoadStatus('Fetching favourites from AniList…');

      try {
        const result = await loadFavouritesFresh(
          form,
          (progress) => {
            if (progress.kind === 'fetching-page' && progress.what === 'favourites') {
              setLoadStatus(
                `Loading favourites (page ${progress.page}, ${progress.itemsSoFar} items)…`,
              );
            }
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          return;
        }
        setAnilistUserId(result.anilistUserId);
        applyLoadedItems(result.items);
        setLoadStatus(null);
        setSuccess(`Loaded ${result.items.length} favourites.`);
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        setLoadStatus(null);
        setError(err instanceof Error ? err.message : 'Load failed.');
      } finally {
        if (loadAbortRef.current === controller) {
          setLoading(false);
        }
      }
    },
    [applyLoadedItems, form],
  );

  const onSave = useCallback(async () => {
    if (!anilistUserId || items.length === 0) {
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const toSave =
        mode === 'select-rank'
          ? itemsWithSortOrder(applySelectRankOrder(items, selectRankState))
          : items;
      await saveFavouriteOrder(form, anilistUserId, toSave);
      const ids = favouriteIdsInOrder(toSave);
      setItems(toSave);
      setSavedIds(ids);
      if (mode === 'select-rank') {
        setSelectRankState(EMPTY_SELECT_RANK_STATE);
        setMode('drag');
      }
      setSuccess(`Saved order for ${toSave.length} favourites on AniList.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [anilistUserId, form, items, mode, selectRankState]);

  const onConfirmDelete = useCallback(async () => {
    if (!anilistUserId || selectedCount === 0) {
      return;
    }
    const idsToDelete = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    const deletedItems = items.filter((item) => selected.has(item.id));

    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      await unfavouriteItems(form, anilistUserId, idsToDelete);
      appendRecentlyDeleted({
        username: form.username.trim(),
        favouriteType: form.favouriteType,
        items: deletedItems,
        deletedAt: Date.now(),
      });
      setRecentlyDeleted(filterRecentlyDeleted(loadRecentlyDeletedBuckets(), form));
      const remaining = items.filter((item) => !selected.has(item.id));
      setItems(remaining);
      setSavedIds((prev) => prev.filter((id) => !selected.has(id)));
      setSelected(new Set());
      setDeleteConfirmOpen(false);
      setSuccess(
        `Removed ${idsToDelete.length} favourite${idsToDelete.length === 1 ? '' : 's'} from AniList.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  }, [anilistUserId, form, items, selected, selectedCount]);

  const onToggleMode = useCallback(() => {
    setDragPreview(null);
    setMode((prev) => {
      const next = prev === 'drag' ? 'select-rank' : 'drag';
      if (next === 'drag') {
        setSelectRankState(EMPTY_SELECT_RANK_STATE);
      } else {
        setSelected(new Set());
      }
      return next;
    });
  }, []);

  const onCancelChanges = useCallback(() => {
    setItems(itemsWithSortOrder(revertItemsToIdOrder(items, savedIds)));
    resetInteraction();
    setMode('drag');
    setSuccess(null);
    setError(null);
  }, [items, resetInteraction, savedIds]);

  const onDeselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const onSelectRankClick = useCallback(
    (index: number, shiftKey: boolean) => {
      setSelectRankState((prev) => handleSelectRankClick(items, index, shiftKey, prev));
    },
    [items],
  );

  const onChipPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLLIElement>, itemId: number) => {
      if (mode !== 'drag' || e.button !== 0) {
        return;
      }

      e.preventDefault();
      clearPointerDragListeners();

      const chip = e.currentTarget;
      pointerDragChipRef.current = chip;
      pointerDragActiveRef.current = false;
      pointerDownItemIdRef.current = itemId;

      const ids = dragPayloadIds(itemsRef.current, itemId, selectedRef.current);
      dragIdsRef.current = ids;
      dragHitRectsRef.current = chipRectsFromGrid(new Set());
      const insertIndex = itemsRef.current.findIndex((item) => item.id === itemId);
      const session: DragPreviewState = {
        draggedIds: ids,
        insertIndex: insertIndex >= 0 ? insertIndex : 0,
      };
      dragSessionRef.current = session;

      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: globalThis.PointerEvent) => {
        ev.preventDefault();
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!pointerDragActiveRef.current) {
          if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX) {
            return;
          }
          pointerDragActiveRef.current = true;
          pointerDragIdRef.current = ev.pointerId;
          try {
            chip.setPointerCapture(ev.pointerId);
          } catch {
            /* capture may fail if the pointer was already released */
          }
          setDragPreview(session);
          setDragPointer({ x: ev.clientX, y: ev.clientY });
        }
        setDragPointer({ x: ev.clientX, y: ev.clientY });
        updateInsertIndexFromPointer(ev.clientX, ev.clientY);
      };
      const onEnd = () => {
        if (!pointerDragActiveRef.current) {
          clearPointerDragListeners();
          dragSessionRef.current = null;
          pointerDragChipRef.current = null;
          pointerDragIdRef.current = null;
          pointerDownItemIdRef.current = null;
          const clickId = itemId;
          if (modeRef.current === 'drag') {
            setSelected((prev) => toggleSelectedId(prev, clickId));
          }
          return;
        }
        pointerDownItemIdRef.current = null;
        finishPointerDrag(true);
      };
      const onCancel = () => {
        finishPointerDrag(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd, { once: true });
      window.addEventListener('pointercancel', onCancel, { once: true });
      pointerDragCleanupRef.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onCancel);
      };
    },
    [chipRectsFromGrid, clearPointerDragListeners, finishPointerDrag, mode, updateInsertIndexFromPointer],
  );

  const onChipClick = useCallback(
    (e: MouseEvent<HTMLLIElement>, itemId: number) => {
      if (mode !== 'select-rank') {
        return;
      }
      const index = items.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        onSelectRankClick(index, e.shiftKey);
      }
    },
    [items, mode, onSelectRankClick],
  );

  const onFavouriteTypeChange = useCallback(
    (favouriteType: ReorderFavouritesForm['favouriteType']) => {
      patchForm({ favouriteType });
      setItems([]);
      setSavedIds([]);
      setAnilistUserId(null);
      resetInteraction();
      setError(null);
      setSuccess(null);
    },
    [patchForm, resetInteraction],
  );

  const busy = loading || saving || deleting;

  return (
    <section
      className={[
        'tool-panel',
        'tool-reorder-favourites-panel',
        items.length > 0 ? 'tool-reorder-favourites-panel--has-toolbar' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="tool-panel-lead">
        Load a favourites list from AniList, reorder it locally, then save back with{' '}
        <code>UpdateFavouriteOrder</code>. Each load re-fetches from AniList and updates
        the local cache.
      </p>

      <form
        className="tool-form-card tool-reorder-favourites-form"
        autoComplete="off"
        onSubmit={onLoad}
      >
        <div className="tool-reorder-favourites-controls">
          <ToolUsernameField
            label="Username"
            value={form.username}
            disabled={busy}
            hint={authHint}
            onChange={(username) => patchForm({ username })}
          />
          <label
            className="tool-field tool-field-label-row tool-field-inline tool-reorder-favourites-type-field"
            htmlFor={FIELD_IDS.favouriteType}
          >
            <span className="tool-field-label">Type</span>
            <select
              id={FIELD_IDS.favouriteType}
              className="slot-search tool-reorder-favourites-type"
              value={form.favouriteType}
              disabled={busy}
              onChange={(e) =>
                onFavouriteTypeChange(e.target.value as ReorderFavouritesForm['favouriteType'])
              }
            >
              {REORDER_FAVOURITE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="tool-reorder-favourites-actions">
          <ToolRunButton
            label="Load favourites"
            running={loading}
            disabled={saving || deleting || !form.username.trim()}
            onRun={() => {
              void onLoad();
            }}
            forceRefreshTitle="Load always re-fetches from AniList"
          />
        </div>
      </form>

      {loadStatus && <p className="tool-status">{loadStatus}</p>}
      {error && <p className="tool-error">{error}</p>}
      {success && <p className="tool-success">{success}</p>}

      {items.length > 0 && (
        <>
          <ol
            ref={gridRef}
            className={[
              'tool-reorder-favourites-grid',
              dragPreview != null ? 'is-drag-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label="Favourites order"
          >
            {displayItems.map((item) => {
              const rankLabel =
                mode === 'select-rank'
                  ? selectRankLabelForItem(item.id, selectRankState)
                  : null;
              const isSelected = selected.has(item.id);
              const isDragging = draggedIdSet.has(item.id);
              const anilistLink = bindAnilistMiddleClick(
                buildAnilistFavouriteUrl(form.favouriteType, item.id),
              );

              return (
                <li
                  key={item.id}
                  data-item-id={item.id}
                  className={mergeAnilistLinkClass(
                    [
                      'tool-reorder-favourites-chip',
                      isSelected ? 'is-selected' : '',
                      isDragging ? 'is-dragging' : '',
                      mode === 'select-rank' ? 'is-select-rank' : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                    anilistLink.className,
                  )}
                  draggable={false}
                  onMouseDown={anilistLink.onMouseDown}
                  onAuxClick={anilistLink.onAuxClick}
                  onPointerDown={(e) => onChipPointerDown(e, item.id)}
                  onClick={(e) => onChipClick(e, item.id)}
                  title={item.label}
                >
                  <input
                    type="checkbox"
                    className="tool-reorder-favourites-chip-checkbox"
                    checked={isSelected}
                    tabIndex={-1}
                    readOnly
                    aria-hidden="true"
                  />
                  {rankLabel && (
                    <span className="tool-reorder-favourites-chip-rank" aria-hidden="true">
                      {rankLabel}
                    </span>
                  )}
                  {item.imageUrl ? (
                    <img
                      className="tool-reorder-favourites-chip-media"
                      src={item.imageUrl}
                      alt=""
                      loading="lazy"
                      draggable={false}
                    />
                  ) : (
                    <span className="tool-reorder-favourites-chip-media tool-reorder-favourites-chip-media--empty" />
                  )}
                  <span className="tool-reorder-favourites-chip-label">{item.label}</span>
                </li>
              );
            })}
          </ol>

          {dragGhostItem && dragPointer && (
            <div
              className="tool-reorder-favourites-drag-ghost"
              style={{ left: `${dragPointer.x}px`, top: `${dragPointer.y}px` }}
              aria-hidden="true"
            >
              {dragGhostItem.imageUrl ? (
                <img
                  className="tool-reorder-favourites-chip-media"
                  src={dragGhostItem.imageUrl}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span className="tool-reorder-favourites-chip-media tool-reorder-favourites-chip-media--empty" />
              )}
              <span className="tool-reorder-favourites-chip-label">{dragGhostItem.label}</span>
              {dragPreview != null && dragPreview.draggedIds.length > 1 && (
                <span className="tool-reorder-favourites-drag-ghost-count">
                  +{dragPreview.draggedIds.length - 1}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {items.length > 0 && (
        <div className="tool-reorder-favourites-toolbar" role="toolbar" aria-label="Favourites actions">
          <button
            type="button"
            className={`btn${mode === 'select-rank' ? ' primary' : ''}`}
            disabled={busy}
            onClick={onToggleMode}
            title={SELECT_TO_ORDER_TOOLTIP}
          >
            {mode === 'select-rank' ? 'Select-to-Order (on)' : 'Select-to-Order'}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !canSave}
            onClick={() => {
              void onSave();
            }}
          >
            {saving ? 'Saving…' : 'Save to Anilist'}
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy || selectedCount === 0 || anilistUserId == null}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            Delete Selected{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || selectedCount === 0}
            onClick={onDeselectAll}
          >
            Deselect All
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !hasPendingChanges}
            onClick={onCancelChanges}
          >
            Cancel
          </button>
          {showUnsavedHint && (
            <span className="tool-reorder-favourites-dirty-hint">Unsaved order changes</span>
          )}
        </div>
      )}

      {recentlyDeleted.length > 0 && (
        <section className="tool-reorder-favourites-recently-deleted">
          <h3 className="tool-reorder-favourites-recently-deleted-title">
            Recently deleted (this tab)
          </h3>
          {recentlyDeleted.map((bucket) => (
            <div key={bucket.deletedAt} className="tool-reorder-favourites-recently-deleted-batch">
              <p className="tool-reorder-favourites-recently-deleted-meta">
                {new Date(bucket.deletedAt).toLocaleString()} — {bucket.items.length} item
                {bucket.items.length === 1 ? '' : 's'}
              </p>
              <ul className="tool-reorder-favourites-recently-deleted-names">
                {bucket.items.map((item) => (
                  <li key={item.id}>{item.label}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {deleteConfirmOpen && (
        <Modal
          label="Confirm unfavourite"
          onClose={() => {
            if (!deleting) {
              setDeleteConfirmOpen(false);
            }
          }}
        >
          <h3>Unfavourite selected items?</h3>
          <p>
            This removes {selectedCount} favourite{selectedCount === 1 ? '' : 's'} from your
            AniList profile. You can see what was removed in Recently deleted until you close
            this tab.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              disabled={deleting}
              onClick={() => setDeleteConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={deleting}
              onClick={() => {
                void onConfirmDelete();
              }}
            >
              {deleting ? 'Removing…' : 'Unfavourite'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
