import { useEffect, useRef, useState } from 'react';
import { CloudBackupSection } from '../components/CloudBackupSection';
import { HistoryBackGuardSetting } from '../components/HistoryBackGuardSetting';
import { SettingsGitHubLink } from '../components/SettingsGitHubLink';
import { SourceDatabasesSection } from '../components/sourceDatabasesSection';
import type { SourceDbSyncControls } from '../hooks/useSourceDbSync';

type SettingsTab = 'settings' | 'database';

const GEAR_TAB_LS_KEY = 'anime-tools:settings:lastTab';

function readPersistedTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(GEAR_TAB_LS_KEY);
    if (raw === 'settings' || raw === 'database') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'settings';
}

function persistTab(tab: SettingsTab): void {
  try {
    localStorage.setItem(GEAR_TAB_LS_KEY, tab);
  } catch {
    /* ignore */
  }
}

interface Props {
  historyBackGuard: boolean;
  onToggleHistoryBackGuard: () => void;
  dbSync: SourceDbSyncControls;
}

export function ToolsSettingsMenu({
  historyBackGuard,
  onToggleHistoryBackGuard,
  dbSync,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(() => readPersistedTab());
  const wrapRef = useRef<HTMLDivElement>(null);

  function selectTab(next: SettingsTab): void {
    setTab(next);
    persistTab(next);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (wrapRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="settings-wrap" ref={wrapRef}>
      <button
        type="button"
        className="toolbar-button gear"
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        title="Settings"
        aria-expanded={open}
      >
        ⚙
      </button>
      {open && (
        <div className="settings-popover anime-to-anime-settings-popover">
          <div className="settings-tabs" role="tablist" aria-label="Settings tabs">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'settings'}
              className={`settings-tab${tab === 'settings' ? ' active' : ''}`}
              onClick={() => selectTab('settings')}
            >
              Settings
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'database'}
              className={`settings-tab${tab === 'database' ? ' active' : ''}`}
              onClick={() => selectTab('database')}
            >
              Database
            </button>
          </div>

          <div className="settings-tab-body" role="tabpanel">
            {tab === 'settings' && (
              <div className="settings-tab-scroll settings-tab-scroll--empty" />
            )}

            {tab === 'database' && (
              <div className="settings-tab-scroll">
                {dbSync.cloudStatus === 'unavailable' ? (
                  <div className="settings-status">
                    Database sync needs autosave enabled. Open the app from a http(s) origin to
                    enable it.
                  </div>
                ) : (
                  <>
                    {dbSync.cloudStatus !== 'ready' && (
                      <>
                        <CloudBackupSection
                          status={dbSync.cloudStatus}
                          showBrowse={false}
                          onSignIn={() => {
                            setOpen(false);
                            dbSync.onCloudSignIn();
                          }}
                          onPickFolder={() => {
                            setOpen(false);
                            dbSync.onCloudPickFolder();
                          }}
                          onSignOut={() => {
                            setOpen(false);
                            dbSync.onCloudSignOut();
                          }}
                        />
                        {dbSync.cloudActionError && (
                          <div className="settings-source-db-error" role="alert">
                            {dbSync.cloudActionError}
                          </div>
                        )}
                        <div className="settings-divider" />
                      </>
                    )}
                    <SourceDatabasesSection
                      cloudStatus={dbSync.cloudStatus}
                      pushingIds={dbSync.dbPushingIds}
                      pullingIds={dbSync.dbPullingIds}
                      sourceDbErrors={dbSync.sourceDbErrors}
                      syncRevision={dbSync.dbSyncRevision}
                      onPushSource={dbSync.onDbPushSource}
                      onPullSource={dbSync.onDbPullSource}
                    />
                    {dbSync.cloudStatus === 'ready' && (
                      <>
                        <div className="settings-divider" />
                        <CloudBackupSection
                          status={dbSync.cloudStatus}
                          folderName={dbSync.cloudFolderName}
                          showBrowse={false}
                          onSignIn={dbSync.onCloudSignIn}
                          onPickFolder={() => {
                            setOpen(false);
                            dbSync.onCloudPickFolder();
                          }}
                          onSignOut={() => {
                            setOpen(false);
                            dbSync.onCloudSignOut();
                          }}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="settings-footer">
            <div className="settings-divider" />
            <HistoryBackGuardSetting
              enabled={historyBackGuard}
              onToggle={onToggleHistoryBackGuard}
            />
            <div className="settings-status settings-footer-meta">
              <span>
                Autosave: {dbSync.autosaveAvailable ? 'on' : 'disabled (file:// origin)'}
              </span>
              <SettingsGitHubLink />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
