import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from 'react';
import {
  ANILIST_ACCOUNTS_CHANGED,
  findAnilistAccountByName,
} from '../../lib/importers/anilist/anilistAuth';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { Modal } from '../../components/Modal';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import {
  loadFavouritesFresh,
  saveFavouriteOrder,
  unfavouriteItems,
} from './reorderFavouritesApi';
import {
  applySelectRankOrder,
  appendRecentlyDeleted,
  DEFAULT_REORDER_FAVOURITES_FORM,
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
} from './reorderFavouritesLogic';

const SELECT_TO_ORDER_TOOLTIP =
  'Click chips to assign rank 1, 2, 3… Click again to clear. Shift+click from the last-clicked chip: forwards rises in list order; backwards rises going left (e.g. click C, shift+click A → C4 B5 A6). No-op if another numbered chip is in the range.';

type DragPreviewState = {
  draggedIds: number[];
  insertIndex: number;
};

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
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [recentlyDeleted, setRecentlyDeleted] = useState<RecentlyDeletedBucket[]>(() =>
    loadRecentlyDeletedBuckets(),
  );
  const [authRevision, setAuthRevision] = useState(0);
  const dragIdsRef = useRef<number[]>([]);
  const loadAbortRef = useRef<AbortController | null>(null);

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

  const displayItems = useMemo(() => {
    if (mode !== 'drag' || !dragPreview) {
      return items;
    }
    return reorderByDrag(items, dragPreview.draggedIds, dragPreview.insertIndex);
  }, [dragPreview, items, mode]);

  const patchForm = useCallback((patch: Partial<ReorderFavouritesForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetInteraction = useCallback(() => {
    setSelected(new Set());
    setSelectRankState(EMPTY_SELECT_RANK_STATE);
    setDragPreview(null);
  }, []);

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

  const onSelectRankClick = useCallback(
    (index: number, shiftKey: boolean) => {
      setSelectRankState((prev) => handleSelectRankClick(items, index, shiftKey, prev));
    },
    [items],
  );

  const onDragStart = useCallback(
    (e: DragEvent<HTMLLIElement>, itemId: number) => {
      if (mode !== 'drag') {
        e.preventDefault();
        return;
      }
      const ids = dragPayloadIds(items, itemId, selected);
      dragIdsRef.current = ids;
      const insertIndex = items.findIndex((item) => item.id === itemId);
      setDragPreview({
        draggedIds: ids,
        insertIndex: insertIndex >= 0 ? insertIndex : 0,
      });
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ids.join(','));
    },
    [items, mode, selected],
  );

  const onDragOver = useCallback(
    (e: DragEvent<HTMLLIElement>, itemId: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (mode !== 'drag' || !dragPreview) {
        return;
      }
      const insertIndex = items.findIndex((item) => item.id === itemId);
      if (insertIndex < 0) {
        return;
      }
      setDragPreview((prev) =>
        prev
          ? {
              draggedIds: prev.draggedIds,
              insertIndex,
            }
          : null,
      );
    },
    [dragPreview, items, mode],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      if (mode !== 'drag' || !dragPreview) {
        setDragPreview(null);
        return;
      }
      setItems((prev) =>
        itemsWithSortOrder(
          reorderByDrag(prev, dragPreview.draggedIds, dragPreview.insertIndex),
        ),
      );
      dragIdsRef.current = [];
      setDragPreview(null);
    },
    [dragPreview, mode],
  );

  const onDragEnd = useCallback(() => {
    dragIdsRef.current = [];
    setDragPreview(null);
  }, []);

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
    <section className="tool-panel tool-reorder-favourites-panel">
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
          <div className="tool-reorder-favourites-toolbar">
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
              disabled={busy || !hasPendingChanges}
              onClick={onCancelChanges}
            >
              Cancel
            </button>
            {showUnsavedHint && (
              <span className="tool-reorder-favourites-dirty-hint">Unsaved order changes</span>
            )}
          </div>

          <ol className="tool-reorder-favourites-grid" aria-label="Favourites order">
            {displayItems.map((item) => {
              const rankLabel =
                mode === 'select-rank'
                  ? selectRankLabelForItem(item.id, selectRankState)
                  : null;
              const isSelected = selected.has(item.id);
              const isDragging =
                dragPreview != null && dragPreview.draggedIds.includes(item.id);

              return (
                <li
                  key={item.id}
                  className={[
                    'tool-reorder-favourites-chip',
                    isSelected ? 'is-selected' : '',
                    isDragging ? 'is-dragging' : '',
                    mode === 'select-rank' ? 'is-select-rank' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={mode === 'drag'}
                  onDragStart={(e) => onDragStart(e, item.id)}
                  onDragOver={(e) => onDragOver(e, item.id)}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  onClick={(e) => onChipClick(e, item.id)}
                >
                  <input
                    type="checkbox"
                    className="tool-reorder-favourites-chip-checkbox"
                    checked={isSelected}
                    aria-label={`Select ${item.label}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelected((prev) => toggleSelectedId(prev, item.id))}
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
        </>
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
