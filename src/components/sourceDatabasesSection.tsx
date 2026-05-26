import type { CloudMenuStatus } from './SettingsMenu';
import { listSources } from '../lib/db/source-registry';
import { getSyncState, type SyncStatus } from '../lib/db/sync';
import { getSourceIcon } from './sourceIcons';

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
  /** Bumps when sync manifest changes so status labels refresh. */
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

  if (cloudStatus !== 'ready' || sources.length === 0) {
    return null;
  }

  void syncRevision;

  return (
    <>
      <div className="settings-status">Source databases</div>
      {sources.map((source) => {
        const sync = getSyncState(source.id);
        const pushing = pushingIds.has(source.id);
        const pulling = pullingIds.has(source.id);
        const busy = pushing || pulling;
        const SourceIcon = getSourceIcon(source.id);

        return (
          <div key={source.id} className="settings-source-db-row">
            <div className="settings-source-db-head">
              <span className="settings-source-db-name">
                <SourceIcon
                  size={16}
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
