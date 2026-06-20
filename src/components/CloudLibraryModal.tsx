import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { CloudSlotMeta } from '../lib/cloud';
import { isFullySyncedWithCloudListing } from '../lib/cloudSync';
import type { SlotMeta } from '../lib/types';
import {
  getAuthState,
  listCloudSlots,
  pickFolder as cloudPickFolder,
  signOut as cloudSignOut,
} from '../lib/cloud';

interface Props {
  /** Called on Cancel / Escape / backdrop click. */
  onClose: () => void;
  /**
   * Called when the user clicks Pull on a row. The handler is async +
   * may surface its own confirm modals (e.g. cap-eviction) before
   * committing — the library modal just hands off the metadata + the
   * pulled blob, doesn't drive the adoption flow itself.
   */
  onPull: (meta: CloudSlotMeta) => void | Promise<void>;
  /** Drive file id → local slot for backups already on this device. */
  localCloudSlotByCloudId: ReadonlyMap<string, SlotMeta>;
  /** Switch to an existing local slot (no download, no duplicate mint). */
  onOpenLocalSlot: (slotId: string) => void;
  /**
   * Remove the local copy when it matches the cloud listing. Cloud file
   * stays in Drive; the row reverts to Pull.
   */
  onRemoveLocalSlot: (slotId: string) => void;
  /**
   * Called after Sign out completes so the App can re-render with the
   * cleared auth state (the gear menu's entries depend on auth state).
   */
  onSignedOut: () => void;
  /**
   * Called after a folder pick changes the active folder so the App can
   * re-fetch / clear caches that depended on the old folder.
   */
  onFolderChanged: () => void;
}

interface ListState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  rows: CloudSlotMeta[];
  /** Surface fetch failures inline rather than throwing; the user
   *  doesn't need a stack trace, just a "couldn't list, try again". */
  errorMessage?: string;
}

/**
 * Phase 1 read-only cloud library. Lists every slot file in the user's
 * chosen Drive folder and lets them Pull one (which routes through the
 * App's `adoptNewSession` so cap-eviction / quota recovery / first-
 * write failure are handled uniformly with every other slot mint).
 *
 * Phase 2 will graft Push controls onto the per-slot rows and the
 * SlotList overlay. This component stays Pull-only — it's the "browse
 * what's in the cloud" view, not the "manage what's synced" view.
 */
export function CloudLibraryModal({
  onClose,
  onPull,
  localCloudSlotByCloudId,
  onOpenLocalSlot,
  onRemoveLocalSlot,
  onSignedOut,
  onFolderChanged,
}: Props) {
  const auth = getAuthState();
  const [list, setList] = useState<ListState>({ status: 'idle', rows: [] });
  /** Per-row pull-in-flight flag. Disables that row's Pull button + the
   *  Sign out button until the pull settles, since pulls can race with
   *  a signOut wiping the access token mid-flight. */
  const [pullingCloudId, setPullingCloudId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (auth.status !== 'signed-in' || !auth.folderId) {
      setList({ status: 'idle', rows: [] });
      return;
    }
    setList({ status: 'loading', rows: [] });
    try {
      const rows = await listCloudSlots();
      // Sort newest-first by Drive's modifiedTime so the most recently
      // pushed slot appears at the top — matches the LIST tab's
      // updatedAt sort and is what users expect when scanning for a
      // recent backup.
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setList({ status: 'loaded', rows });
    } catch (err) {
      setList({
        status: 'error',
        rows: [],
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }, [auth.status, auth.folderId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handlePull(meta: CloudSlotMeta): Promise<void> {
    if (pullingCloudId) return;
    setPullingCloudId(meta.cloudId);
    try {
      await onPull(meta);
    } finally {
      setPullingCloudId(null);
    }
  }

  async function handleSignOut(): Promise<void> {
    if (pullingCloudId) return;
    await cloudSignOut();
    onSignedOut();
    onClose();
  }

  async function handleChangeFolder(): Promise<void> {
    if (pullingCloudId) return;
    try {
      await cloudPickFolder();
      onFolderChanged();
      // Re-list against the new folder.
      await refresh();
    } catch (err) {
      // pickFolder rejects on cancel / no-selection. That's not an
      // error worth surfacing in the list area — just leave the old
      // folder in place.
      console.debug('folder pick canceled', err);
    }
  }

  // ---------- render branches ----------

  if (auth.status === 'signed-out' || auth.status === 'expired') {
    return (
      <Modal label="Cloud library" onClose={onClose} className="modal-wide">
        <h3>Cloud library</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          Sign in to Google Drive from the Settings menu to see your cloud backups.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  if (!auth.folderId) {
    return (
      <Modal label="Cloud library" onClose={onClose} className="modal-wide">
        <h3>Cloud library</h3>
        <p style={{ color: 'var(--text-muted)' }}>
          Pick a Drive folder to store your sorter backups in. The app only sees the folder
          you pick &mdash; nothing else in your Drive.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={handleChangeFolder}>
            Pick a folder…
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal label="Cloud library" onClose={onClose} className="modal-wide">
      <h3>Cloud library</h3>
      <p style={{ color: 'var(--text-muted)', marginBottom: '0.5em' }}>
        Folder: <strong>{auth.folderName ?? 'Unnamed folder'}</strong>
      </p>
      {list.status === 'loading' && (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      )}
      {list.status === 'error' && (
        <p style={{ color: 'var(--text-danger)' }}>
          Couldn&rsquo;t list cloud files: {list.errorMessage}
        </p>
      )}
      {list.status === 'loaded' && list.rows.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          No backups in this folder yet. Push a slot from the LIST tab to back it up here.
        </p>
      )}
      {list.status === 'loaded' && list.rows.length > 0 && (
        <ul className="cloud-library-list">
          {list.rows.map((row) => {
            const localSlot = localCloudSlotByCloudId.get(row.cloudId);
            return (
            <CloudLibraryRow
              key={row.cloudId}
              meta={row}
              localSlot={localSlot}
              actionDisabled={pullingCloudId !== null}
              isPulling={pullingCloudId === row.cloudId}
              onPull={() => handlePull(row)}
              onOpenLocal={() => {
                if (localSlot) {
                  onOpenLocalSlot(localSlot.id);
                  onClose();
                }
              }}
              onRemoveLocal={() => {
                if (localSlot) {
                  onRemoveLocalSlot(localSlot.id);
                }
              }}
            />
            );
          })}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn" onClick={() => void refresh()} disabled={list.status === 'loading'}>
          Refresh
        </button>
        <button className="btn" onClick={() => void handleChangeFolder()} disabled={pullingCloudId !== null}>
          Change folder…
        </button>
        <button className="btn danger" onClick={() => void handleSignOut()} disabled={pullingCloudId !== null}>
          Sign out
        </button>
      </div>
    </Modal>
  );
}

interface RowProps {
  meta: CloudSlotMeta;
  localSlot: SlotMeta | undefined;
  actionDisabled: boolean;
  isPulling: boolean;
  onPull: () => void;
  onOpenLocal: () => void;
  onRemoveLocal: () => void;
}

function CloudLibraryRow({
  meta,
  localSlot,
  actionDisabled,
  isPulling,
  onPull,
  onOpenLocal,
  onRemoveLocal,
}: RowProps) {
  const alreadyLocal = localSlot !== undefined;
  const fullySynced = isFullySyncedWithCloudListing(localSlot, meta);
  return (
    <li className={`cloud-library-row${alreadyLocal ? ' cloud-library-row--local' : ''}`}>
      <div className="cloud-library-row-main">
        <div className="cloud-library-row-name" title={meta.filename}>
          {meta.displayName}
        </div>
        <div className="cloud-library-row-meta">
          {formatBytes(meta.sizeBytes)} &middot; updated {formatDate(meta.updatedAt)}
          {alreadyLocal && (
            <>
              {' '}
              &middot;{' '}
              <button
                type="button"
                className="cloud-library-row-local-link"
                onClick={onOpenLocal}
                disabled={actionDisabled}
                title="Open the local copy of this backup"
              >
                on this device
              </button>
            </>
          )}
        </div>
      </div>
      {alreadyLocal ? (
        <button
          type="button"
          className="btn cloud-library-row-remove-local"
          onClick={onRemoveLocal}
          disabled={actionDisabled || !fullySynced}
          title={
            fullySynced
              ? 'Remove local copy — cloud backup stays in Drive'
              : 'Sync or pull before removing the local copy'
          }
          aria-label={`Remove local copy of ${meta.displayName}`}
        >
          <span className="cloud-library-row-remove-local-icon" aria-hidden>
            ✓
          </span>
          On device
        </button>
      ) : (
        <button
          type="button"
          className="btn primary"
          onClick={onPull}
          disabled={actionDisabled}
          title={isPulling ? 'Pulling…' : 'Download this slot into a new local slot'}
        >
          {isPulling ? 'Pulling…' : 'Pull'}
        </button>
      )}
    </li>
  );
}

/**
 * Format bytes for the row meta line. Two-significant-digit truncation
 * with a unit suffix — the slot file sizes range from a few hundred
 * bytes (empty progress) up to a few hundred KB (large rankings with
 * undo rings), so KB / MB is enough granularity.
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let v = n;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
  return `${rounded} ${units[idx]}`;
}

/**
 * Format an ISO timestamp as a short relative-ish date. Returns the
 * same local-date string the LIST tab uses elsewhere (`YYYY-MM-DD
 * HH:MM`) so the visual style stays consistent across the gear menu
 * and the cloud library.
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  } catch {
    return iso;
  }
}
