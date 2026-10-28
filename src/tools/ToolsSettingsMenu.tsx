import { useEffect, useRef, useState } from 'react';
import { CloudBackupSection } from '../components/CloudBackupSection';
import { AnilistDisplayPreferencesPanel } from '../components/AnilistDisplayPreferencesPanel';
import { HistoryBackGuardSetting } from '../components/HistoryBackGuardSetting';
import { SettingsGitHubLink } from '../components/SettingsGitHubLink';
import { SourceDatabasesSection } from '../components/sourceDatabasesSection';
import { AnilistAccountsSection } from '../components/AnilistAccountsSection';
import { SpotifySection } from '../components/SpotifySection';
import { StorageDiagnosticsSection } from '../components/StorageDiagnosticsSection';
import type { SourceDbSyncControls } from '../hooks/useSourceDbSync';
import { useToolsPreferences } from '../hooks/useToolsPreferences';
import type { ToolId } from './toolTypes';

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

/** Keeps the draft text locally so clearing the field doesn't snap back; only valid numbers save. */
function SettingsNumberInput({
  label,
  className,
  value,
  disabled,
  isValid,
  onCommit,
}: {
  label: string;
  className?: string;
  value: number;
  disabled: boolean;
  isValid: (value: number) => boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);
  return (
    <label className={['tools-settings-number', className].filter(Boolean).join(' ')}>
      {label}
      <input
        className="slot-search"
        type="number"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number(e.target.value);
          if (e.target.value.trim() !== '' && isValid(parsed)) onCommit(parsed);
        }}
        onBlur={() => setText(String(value))}
      />
    </label>
  );
}

interface Props {
  activeTool: ToolId;
  historyBackGuard: boolean;
  onToggleHistoryBackGuard: () => void;
  dbSync: SourceDbSyncControls;
}

export function ToolsSettingsMenu({
  activeTool,
  historyBackGuard,
  onToggleHistoryBackGuard,
  dbSync,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(() => readPersistedTab());
  const wrapRef = useRef<HTMLDivElement>(null);
  const {
    prefs: toolsPrefs,
    setProductionAllRoles,
    setBumpChartBestMatchByTitle,
    setBumpChartIncludeExportImages,
    setBumpChartMalExportImages,
    setSeasonalScoresShowRepeats,
    setSeasonalScoresSpanAiringSeasons,
    setWeeklyCalendarShowUnscheduledColumn,
    setWeeklyCalendarShowThemeSongs,
    setScoreComparisonRescale,
    setScoreComparisonTargetMean,
    setScoreComparisonTargetStdDev,
  } = useToolsPreferences();

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
                <AnilistDisplayPreferencesPanel standalone />
                <div
                  className={`tools-settings-section${activeTool === 'seasonal-scores' ? ' active' : ''}`}
                  data-tool-settings-section="seasonal-scores"
                >
                  <div className="settings-divider" />
                  <p className="edit-item-advanced-title">Seasonal Scores</p>
                  <label
                    className="settings-item checkbox"
                    title="Show repeated watch counts as ×n and count the entry n times for average ratings."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.seasonalScoresShowRepeats}
                      onChange={(e) =>
                        setSeasonalScoresShowRepeats(e.target.checked)
                      }
                    />
                    Show repeats
                  </label>
                  <label
                    className="settings-item checkbox"
                    title="Place shows in every season column their broadcast dates overlap (ongoing shows extend through today)."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.seasonalScoresSpanAiringSeasons}
                      onChange={(e) =>
                        setSeasonalScoresSpanAiringSeasons(e.target.checked)
                      }
                    />
                    Span airing seasons
                  </label>
                </div>
                <div
                  className={`tools-settings-section${activeTool === 'weekly-calendar' ? ' active' : ''}`}
                  data-tool-settings-section="weekly-calendar"
                >
                  <div className="settings-divider" />
                  <p className="edit-item-advanced-title">Weekly Calendar</p>
                  <label
                    className="settings-item checkbox"
                    title="Load and display cached theme songs for shows in Weekly Calendar."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.weeklyCalendarShowThemeSongs}
                      onChange={(e) =>
                        setWeeklyCalendarShowThemeSongs(e.target.checked)
                      }
                    />
                    Show theme songs
                  </label>
                  <label
                    className="settings-item checkbox"
                    title="Show entries whose airing weekday cannot be determined in an extra Unknown column."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.weeklyCalendarShowUnscheduledColumn}
                      onChange={(e) =>
                        setWeeklyCalendarShowUnscheduledColumn(e.target.checked)
                      }
                    />
                    Unknown Airing Day column
                  </label>
                </div>
                <div
                  className={`tools-settings-section${activeTool === 'shared-staff' ? ' active' : ''}`}
                  data-tool-settings-section="shared-staff"
                >
                  <div className="settings-divider" />
                  <p className="edit-item-advanced-title">Shared Staff</p>
                  <label
                    className="settings-item checkbox"
                    title="When off, the Shared Staff compare chart hides non-core production credits (e.g. Storyboard, Production Assistant) and only lists key roles like Director, Music, and Script."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.productionAllRoles}
                      onChange={(e) => setProductionAllRoles(e.target.checked)}
                    />
                    Show all production roles
                  </label>
                </div>
                <div
                  className={`tools-settings-section${activeTool === 'bump-chart' ? ' active' : ''}`}
                  data-tool-settings-section="bump-chart"
                >
                  <div className="settings-divider" />
                  <p className="edit-item-advanced-title">Bump Chart</p>
                  <label
                    className="settings-item checkbox"
                    title="Exact logical IDs always match first.&#10;&#10;When enabled, remaining rows match only when an exact stored label (including a custom label) or AniList title-language variant identifies one unique pair.&#10;&#10;Ambiguous titles and conflicting AniList IDs stay disconnected.&#10;&#10;The info icon marks inferred lines."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.bumpChartBestMatchByTitle}
                      onChange={(e) =>
                        setBumpChartBestMatchByTitle(e.target.checked)
                      }
                    />
                    Best match by title
                  </label>
                  <label
                    className="settings-item checkbox"
                    title="When enabled, available item images are included in Bump Chart PNG exports."
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.bumpChartIncludeExportImages}
                      onChange={(e) =>
                        setBumpChartIncludeExportImages(e.target.checked)
                      }
                    />
                    Include images in PNG exports
                  </label>
                  <label
                    className="settings-item checkbox"
                    title={
                      toolsPrefs.bumpChartIncludeExportImages
                        ? 'When enabled, PNG exports try to replace unavailable AniList covers with verified MyAnimeList images. Live chart images are unchanged.'
                        : 'Turn on Include images in PNG exports to use MyAnimeList fallback images.'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={toolsPrefs.bumpChartMalExportImages}
                      disabled={!toolsPrefs.bumpChartIncludeExportImages}
                      onChange={(e) =>
                        setBumpChartMalExportImages(e.target.checked)
                      }
                    />
                    Use MyAnimeList images in PNG exports
                  </label>
                </div>
                <div
                  className={`tools-settings-section${activeTool === 'score-comparison' ? ' active' : ''}`}
                  data-tool-settings-section="score-comparison"
                >
                  <div className="settings-divider" />
                  <p className="edit-item-advanced-title">User Scores</p>
                  <div
                    className="settings-item checkbox tools-settings-score-scale"
                    title="When on, normalized scores are shown on this scale (mean + z × std dev) instead of as raw z-scores."
                  >
                    <input
                      type="checkbox"
                      aria-label="Rescale normalized scores"
                      checked={toolsPrefs.scoreComparisonRescale}
                      onChange={(e) => setScoreComparisonRescale(e.target.checked)}
                    />
                    <SettingsNumberInput
                      label="Mean"
                      value={toolsPrefs.scoreComparisonTargetMean}
                      disabled={!toolsPrefs.scoreComparisonRescale}
                      isValid={Number.isFinite}
                      onCommit={setScoreComparisonTargetMean}
                    />
                    <SettingsNumberInput
                      label="Std Dev"
                      className="tools-settings-number--narrow"
                      value={toolsPrefs.scoreComparisonTargetStdDev}
                      disabled={!toolsPrefs.scoreComparisonRescale}
                      isValid={(n) => Number.isFinite(n) && n > 0}
                      onCommit={setScoreComparisonTargetStdDev}
                    />
                  </div>
                </div>
              </div>
            )}

            {tab === 'database' && (
              <div className="settings-tab-scroll">
                {dbSync.cloudStatus === 'unavailable' ? (
                  <>
                    <div className="settings-status">
                      Database sync needs autosave enabled. Open the app from a http(s) origin to
                      enable it.
                    </div>
                    <AnilistAccountsSection />
                    <div className="settings-divider" />
                    <SpotifySection />
                  </>
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
                    <div className="settings-divider" />
                    <AnilistAccountsSection />
                    <div className="settings-divider" />
                    <SpotifySection />
                  </>
                )}
                <div className="settings-divider" />
                <StorageDiagnosticsSection />
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
