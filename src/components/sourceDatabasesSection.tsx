import type { CloudMenuStatus } from './SettingsMenu';
import { listSources } from '../lib/db/source-registry';
import { getSyncState, type SyncStatus } from '../lib/db/sync';
import { getPendingChanges } from '../lib/db/syncManifest';
import { getSourceIcon } from './sourceIcons';

/**
 * Per-source database row inside the gear menu's "Databases" tab.
 *
 * Each registered source gets one card showing: brand icon + id, sync
 * status, last push/pull timestamps, errors (when present), and the
 * Push/Pull buttons. When ad-hoc writes have accumulated since the
 * last full refresh (per-entry detail expansion bumps
 * `syncManifest.pendingChanges`), the card surfaces a yellow
 * "N pending changes — Push now" affordance so the user has a
 * one-click flush path.
 *
 * The actual refresh affordances for a source (e.g. AniList username
 * + per-list import + favourites refresh) deliberately live on the
 * StartScreen anilist mode, NOT here. This row is purely cloud-sync
 * controls; refresh = "fetch source data", sync = "shuttle the local
 * DB to/from Drive". Conflating the two made the gear menu cramped
 * (the previous AnilistSourcePanel rendered three input rows + two
 * action rows + a meta block per source) — splitting them keeps each
 * surface focused.
 */

function formatTs(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  return new Date(ms).toLocaleString();
}

function statusLabel(status: SyncStatus): string {
  switch (status) {
    case 'in-sync':
      return 'in sync';
    case 'drifted':
      return 'drifted';
    case 'unsynced':
      return 'unsynced';
    default:
      return 'unknown';
  }
}

interface Props {
  cloudStatus: CloudMenuStatus;
  pushingIds: ReadonlySet<string>;
  pullingIds: ReadonlySet<string>;
  sourceDbErrors: Record<string, string>;
  /** Bumps when sync manifest changes so status labels + pending
   *  counters refresh after a per-entry write lands. */
  syncRevision: number;
  onPushSource: (sourceId: string) => void;
  onPullSource: (sourceId: string) => void;
}

export function SourceDatabasesSection({
  cloudStatus,
  pushingIds,
  pullingIds,
  sourceDbErrors,
  syncRevision,
  onPushSource,
  onPullSource,
}: Props) {
  const sources = listSources();

  if (sources.length === 0) return null;

  // Re-reading getSyncState() / getPendingChanges() inside the map is
  // the actual dependency on syncRevision; the void here keeps the
  // prop in the closure's dependency graph for linters even when the
  // JSX layer doesn't read it directly.
  void syncRevision;

  const cloudReady = cloudStatus === 'ready';

  return (
    <>
      <div className="settings-status">Source databases</div>
      {sources.map((source) => {
        const sync = getSyncState(source.id);
        const pushing = pushingIds.has(source.id);
        const pulling = pullingIds.has(source.id);
        const busy = pushing || pulling;
        const SourceIcon = getSourceIcon(source.id);
        const pending = getPendingChanges(source.id);

        // Cloud not connected: collapse to a status-only hint so the
        // row still tells the user the source is registered, just
        // inert. No push/pull, no pending counter — there's nowhere
        // for the pending count to flush to without cloud.
        if (!cloudReady) {
          return (
            <div key={source.id} className="settings-source-db-row">
              <div className="settings-source-db-head">
                <span className="settings-source-db-name">
                  <SourceIcon
                    size={14}
                    className="settings-source-db-icon"
                  />
                  <span>{source.id}</span>
                </span>
                <span className="settings-source-db-status">
                  cloud not connected
                </span>
              </div>
            </div>
          );
        }

        return (
          <div key={source.id} className="settings-source-db-row">
            <div className="settings-source-db-head">
              <span className="settings-source-db-name">
                <SourceIcon
                  size={14}
                  className="settings-source-db-icon"
                />
                <span>{source.id}</span>
              </span>
              <span className="settings-source-db-status" title="Sync status">
                {statusLabel(sync.status)}
              </span>
            </div>
            <div className="settings-source-db-meta">
              <span>Pushed: {formatTs(sync.lastPushAt)}</span>
              <span>Pulled: {formatTs(sync.lastPullAt)}</span>
            </div>
            {pending > 0 && (
              <div className="settings-source-db-pending">
                <span>
                  {pending} pending change{pending === 1 ? '' : 's'} — manual
                  push required.
                </span>
                <button
                  type="button"
                  className="settings-item primary"
                  disabled={busy}
                  onClick={() => onPushSource(source.id)}
                  title="Push the local DB to your cloud folder now"
                >
                  {pushing ? 'Pushing…' : 'Push now'}
                </button>
              </div>
            )}
            {sourceDbErrors[source.id] && (
              <div className="settings-source-db-error" role="alert">
                {sourceDbErrors[source.id]}
              </div>
            )}
            <div className="settings-source-db-actions">
              <button
                type="button"
                className="settings-item"
                disabled={busy}
                onClick={() => onPushSource(source.id)}
              >
                {pushing ? 'Pushing…' : 'Push'}
              </button>
              <button
                type="button"
                className="settings-item"
                disabled={busy}
                onClick={() => onPullSource(source.id)}
              >
                {pulling ? 'Pulling…' : 'Pull'}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
