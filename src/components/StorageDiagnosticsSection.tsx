import { useEffect, useState } from 'react';
import {
  clearEveryDisposableCache,
  clearImageCaches,
  clearSpotifyCaches,
  clearToolsApiCaches,
  collectStorageDiagnostics,
  requestPersistentStorage,
  type StorageDiagnostics,
} from '../lib/storageDiagnostics';

const DIAGNOSTIC_HELP = {
  originUsage:
    'The browser’s estimate of storage used by this site across Sorter, Anime-to-Anime, and Tools, compared with the quota currently available to the site.',
  persistentStorage:
    'Persistent storage asks the browser not to automatically evict this site’s data under device storage pressure. “Not enabled” does not mean saving is broken; the data remains stored normally.',
  lastQuotaError:
    'The most recent time this tab could not complete a durable save because the browser reported that storage was full.',
  lastCleanupError:
    'The most recent failure while removing disposable caches. User saves, settings, accounts, and source databases are never part of this cleanup.',
} as const;

const ACTION_HELP = {
  refresh:
    'Re-measure browser storage and cache sizes. This does not delete anything.',
  images:
    'Remove cached Bump Chart export image files and resolved MyAnimeList image URLs. Future PNG exports fetch or resolve them again.',
  tools:
    'Remove cached AniList responses used by Tools, including relation, Shared Staff, and Weekly Calendar lookups. The tools fetch them again when needed.',
  spotify:
    'Remove cached track lists for playlists that are not currently selected. The selected playlist and track-to-ISRC mappings are kept.',
  all:
    'Remove all disposable image, Tools/API, and non-selected Spotify playlist caches. Sorter saves, Bump Chart saves, settings, accounts, source databases, and Spotify ISRC mappings are kept.',
  persistence:
    'Ask the browser to protect this site’s stored data from automatic eviction when the device is under storage pressure.',
} as const;

function formatBytes(bytes: number | null): string {
  if (bytes == null) {
    return 'Unavailable';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function quotaPercent(diagnostics: StorageDiagnostics | null): number | null {
  if (!diagnostics?.quota || diagnostics.usage == null) {
    return null;
  }
  return (diagnostics.usage / diagnostics.quota) * 100;
}

export function StorageDiagnosticsSection() {
  const [expanded, setExpanded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [pressurePercent, setPressurePercent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.storage?.estimate) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigator.storage.estimate().then(
        (estimate) => {
          if (estimate.usage != null && estimate.quota) {
            setPressurePercent((estimate.usage / estimate.quota) * 100);
          }
        },
        () => {},
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const next = await collectStorageDiagnostics();
      setDiagnostics(next);
      setPressurePercent(quotaPercent(next));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(
    action: () => Promise<void>,
    successMessage: string,
  ): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setStatus(successMessage);
      const next = await collectStorageDiagnostics();
      setDiagnostics(next);
      setPressurePercent(quotaPercent(next));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Storage action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function requestPersistence(): Promise<void> {
    setBusy(true);
    setStatus('Requesting persistent storage from the browser…');
    try {
      const persisted = await requestPersistentStorage();
      setStatus(
        persisted == null
          ? 'Persistent storage is unavailable in this browser.'
          : persisted
            ? 'Persistent storage is enabled.'
            : 'The browser declined persistent storage. Browsers decide automatically and usually do not show a prompt.',
      );
      const next = await collectStorageDiagnostics();
      setDiagnostics(next);
      setPressurePercent(quotaPercent(next));
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : 'The persistent-storage request failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  const percent = quotaPercent(diagnostics) ?? pressurePercent;
  const pressureLevel =
    percent != null && percent >= 85
      ? 'critical'
      : percent != null && percent >= 70
        ? 'warning'
        : null;

  return (
    <section className="storage-diagnostics">
      {pressureLevel && (
        <div className={`settings-status storage-pressure storage-pressure--${pressureLevel}`}>
          Browser storage is {percent?.toFixed(1)}% full. Clear disposable
          caches below or remove data you no longer need.
        </div>
      )}
      <details
        onToggle={(event) => {
          const isOpen = event.currentTarget.open;
          setExpanded(isOpen);
          if (isOpen && !diagnostics) {
            void refresh();
          }
        }}
      >
        <summary>Advanced storage diagnostics</summary>
        {expanded && (
          <div className="storage-diagnostics-body">
            {diagnostics ? (
              <>
                <dl className="storage-diagnostics-summary">
                  <div>
                    <dt title={DIAGNOSTIC_HELP.originUsage}>Origin usage</dt>
                    <dd>
                      {formatBytes(diagnostics.usage)} /{' '}
                      {formatBytes(diagnostics.quota)}
                      {percent == null ? '' : ` (${percent.toFixed(1)}%)`}
                    </dd>
                  </div>
                  <div>
                    <dt title={DIAGNOSTIC_HELP.persistentStorage}>
                      Persistent storage
                    </dt>
                    <dd>
                      {diagnostics.persisted == null
                        ? 'Unavailable'
                        : diagnostics.persisted
                          ? 'Enabled'
                          : 'Not enabled'}
                    </dd>
                  </div>
                  <div>
                    <dt title={DIAGNOSTIC_HELP.lastQuotaError}>
                      Last quota error
                    </dt>
                    <dd>{diagnostics.lastQuotaErrorAt ?? 'None this session'}</dd>
                  </div>
                  <div>
                    <dt title={DIAGNOSTIC_HELP.lastCleanupError}>
                      Last cleanup error
                    </dt>
                    <dd>{diagnostics.lastCleanupError ?? 'None'}</dd>
                  </div>
                </dl>

                <h4>Browser stores</h4>
                <ul className="storage-diagnostics-list">
                  {diagnostics.stores.map((store) => (
                    <li key={store.id}>
                      <span>{store.label}</span>
                      <span>
                        {store.entries} records · {formatBytes(store.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>

                <h4>localStorage owners</h4>
                <ul className="storage-diagnostics-list">
                  {diagnostics.localStorage.map((owner) => (
                    <li key={owner.owner}>
                      <span>{owner.owner}</span>
                      <span>
                        {owner.entries} records · {formatBytes(owner.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="settings-status">Collecting storage diagnostics…</p>
            )}

            <div className="storage-diagnostics-actions">
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.refresh}
                onClick={() => void refresh()}
              >
                Refresh diagnostics
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.tools}
                onClick={() =>
                  void runAction(clearToolsApiCaches, 'Tools/API cache cleared.')
                }
              >
                Clear tools/API cache
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.spotify}
                onClick={() =>
                  void runAction(
                    clearSpotifyCaches,
                    'Non-selected Spotify caches cleared.',
                  )
                }
              >
                Clear Spotify caches
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.images}
                onClick={() =>
                  void runAction(clearImageCaches, 'Image caches cleared.')
                }
              >
                Clear image cache
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.all}
                onClick={() =>
                  void runAction(clearEveryDisposableCache, 'Disposable caches cleared.')
                }
              >
                Clear all disposable caches
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                title={ACTION_HELP.persistence}
                onClick={() => void requestPersistence()}
              >
                Request persistent storage
              </button>
            </div>
            {status && (
              <p className="settings-status" role="status" aria-live="polite">
                {status}
              </p>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
