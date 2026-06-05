import { useEffect, useRef, useState } from 'react';
import { CloudBackupSection } from '../components/CloudBackupSection';
import { SourceDatabasesSection } from '../components/sourceDatabasesSection';
import type { CloudMenuStatus } from '../components/SettingsMenu';
import { SORTER_HOME_HREF } from '../lib/appRoutes';
import type { RoundConfig, VaListImageMode } from './preferences';

type SettingsTab = 'settings' | 'database';

const GEAR_TAB_LS_KEY = 'anime-to-anime:settings:lastTab';

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

interface DbSyncProps {
  autosaveAvailable: boolean;
  cloudStatus: CloudMenuStatus;
  cloudFolderName?: string;
  cloudActionError: string | null;
  onCloudSignIn: () => void;
  onCloudPickFolder: () => void;
  onCloudSignOut: () => void;
  dbPushingIds: ReadonlySet<string>;
  dbPullingIds: ReadonlySet<string>;
  sourceDbErrors: Record<string, string>;
  dbSyncRevision: number;
  onDbPushSource: (sourceId: string) => void;
  onDbPullSource: (sourceId: string) => void;
}

interface Props {
  vaListImageMode: VaListImageMode;
  onVaListImageModeChange: (mode: VaListImageMode) => void;
  roundConfig: RoundConfig;
  onRoundConfigChange: (patch: Partial<RoundConfig>) => void;
  dbSync: DbSyncProps;
}

export function AnimeToAnimeSettingsMenu({
  vaListImageMode,
  onVaListImageModeChange,
  roundConfig,
  onRoundConfigChange,
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
              <div className="settings-tab-scroll">
                <p className="edit-item-advanced-title">Round rules</p>
                <p className="settings-popover-hint">Applied when you start or restart a round.</p>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.allowProduction}
                    onChange={(e) => onRoundConfigChange({ allowProduction: e.target.checked })}
                  />
                  Production credits
                </label>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.productionAllRoles}
                    disabled={!roundConfig.allowProduction}
                    onChange={(e) => onRoundConfigChange({ productionAllRoles: e.target.checked })}
                  />
                  All production roles
                </label>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.allowRelations}
                    onChange={(e) => onRoundConfigChange({ allowRelations: e.target.checked })}
                  />
                  Franchise relations mode
                </label>

                <p className="edit-item-advanced-title settings-popover-section-title">
                  Voice actor list
                </p>
                <label className="settings-item checkbox">
                  <input
                    type="radio"
                    name="anime-to-anime-va-image"
                    checked={vaListImageMode === 'staff'}
                    onChange={() => onVaListImageModeChange('staff')}
                  />
                  Show voice actor photo
                </label>
                <label className="settings-item checkbox">
                  <input
                    type="radio"
                    name="anime-to-anime-va-image"
                    checked={vaListImageMode === 'character'}
                    onChange={() => onVaListImageModeChange('character')}
                  />
                  Show character photo
                </label>
              </div>
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
                <div className="settings-status">
                  To refresh AniList data, use the{' '}
                  <a href={SORTER_HOME_HREF}>main Sorter app&apos;s Start screen</a>.
                </div>
              </div>
            )}
          </div>

          <div className="settings-footer">
            <div className="settings-divider" />
            <div className="settings-status">
              Autosave: {dbSync.autosaveAvailable ? 'on' : 'disabled (file:// origin)'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
