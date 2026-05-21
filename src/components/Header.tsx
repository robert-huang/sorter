import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SettingsMenu, type CloudMenuStatus } from './SettingsMenu';
import { CheckIcon, FloppyIcon } from './icons';
import type { SlotsManifest, SortState } from '../lib/types';
import { comparisonsRemaining } from '../lib/engine';
import type { ThemeName } from '../lib/storage';

export type TabId = 'start' | 'list' | 'rank' | 'result';

interface Props {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  state: SortState | null;
  canUndo: boolean;
  onUndo: () => void;
  /** Force-flush the autosave (in-browser save) for the active slot. */
  onSaveNow: () => void;
  /** Download the active slot's session as a JSON file. */
  onDownload: () => void;
  autosaveAvailable: boolean;
  onLoadFromFile: (file: File) => void;
  /** Confirm + delete the active slot. */
  onReset: () => void;
  /** Trigger a JSON download of every slot in one archive file. */
  onBackupAll: () => void;
  /** Hand a SlotArchive JSON file to App for parsing + confirm modal. */
  onRestoreFromBackup: (file: File) => void;
  /** Full slots manifest — feeds the gear-menu slot list. */
  manifest: SlotsManifest;
  /** Slot currently loaded into memory; null when on START. */
  loadedSlotId: string | null;
  onSwitchSlot: (id: string) => void;
  onDeleteSlot: (id: string) => void;
  onRenameSlot: (id: string, name: string) => void;
  /** Pin/unpin a slot from the gear-menu row. Pinned slots are excluded
   *  from the auto-eviction loop when storage hits the cap. */
  onTogglePinSlot: (id: string, pinned: boolean) => void;
  /** Download a JSON copy of any slot's on-disk blob (per-row icon in
   *  the gear menu). Distinct from `onDownload`, which dumps the
   *  in-memory active session. */
  onDownloadSlot: (id: string) => void;
  /** When in 'start' mode with no items yet, RANK / LIST / RESULT tabs are disabled. */
  hasState: boolean;
  theme: ThemeName;
  onToggleTheme: () => void;
  showEstimatedRemaining: boolean;
  onToggleShowEstimatedRemaining: () => void;
  /** Whether the merge engine may auto-insert skewed pairs. Default on. */
  autoInsertEnabled: boolean;
  onToggleAutoInsertEnabled: () => void;
  // ---------- cloud backup (tier 0b) ----------
  cloudStatus: CloudMenuStatus;
  cloudFolderName?: string;
  onCloudSignIn: () => void;
  onCloudPickFolder: () => void;
  onCloudBrowse: () => void;
  onCloudSignOut: () => void;
  onCloudToggleOptIn: (id: string, optIn: boolean) => void;
  onCloudPushSlot: (id: string) => void;
  onCloudPullSlot: (id: string) => void;
  /** Per-row in-flight indicators forwarded straight to SettingsMenu →
   *  SlotList → CloudRowControls. Header doesn't read them, it just
   *  pipes them through; declared here so the existing top-down prop
   *  chain stays the single source of truth for the gear menu. */
  cloudPushingIds: ReadonlySet<string>;
  cloudPullingIds: ReadonlySet<string>;
}


export function Header({
  activeTab,
  onTabChange,
  state,
  canUndo,
  onUndo,
  onSaveNow,
  onDownload,
  autosaveAvailable,
  onLoadFromFile,
  onReset,
  onBackupAll,
  onRestoreFromBackup,
  manifest,
  loadedSlotId,
  onSwitchSlot,
  onDeleteSlot,
  onRenameSlot,
  onTogglePinSlot,
  onDownloadSlot,
  hasState,
  theme,
  onToggleTheme,
  showEstimatedRemaining,
  onToggleShowEstimatedRemaining,
  autoInsertEnabled,
  onToggleAutoInsertEnabled,
  cloudStatus,
  cloudFolderName,
  onCloudSignIn,
  onCloudPickFolder,
  onCloudBrowse,
  onCloudSignOut,
  onCloudToggleOptIn,
  onCloudPushSlot,
  onCloudPullSlot,
  cloudPushingIds,
  cloudPullingIds,
}: Props) {
  // `remaining` feeds the optional "~K left" suffix on the toolbar stats
  // label. The progress bar that used to live in the header has moved into
  // CompareScreen (rank-tab-only), so the percent-of-total math also lives
  // there now. We pass autoInsertEnabled so the per-pair forecast charges
  // the cheaper of merge / auto-insert when the heuristic is enabled.
  const remaining = state
    ? comparisonsRemaining(state, { autoInsertEnabled })
    : 0;
  const cmps = state?.comparisons ?? 0;

  // "Comparison #N" framing — N is the click the user is about to make
  // (1-indexed). After the sort is done, just show the final tally.
  const statText = (() => {
    if (!state) return '';
    if (state.done) return `Done · ${cmps} comparisons`;
    const n = cmps + 1;
    return showEstimatedRemaining
      ? `Comparison #${n} · ~${remaining} left`
      : `Comparison #${n}`;
  })();

  const tabs: Array<{ id: TabId; label: string; disabled?: boolean }> = [
    { id: 'start', label: 'START' },
    { id: 'list', label: 'LIST', disabled: !hasState },
    { id: 'rank', label: 'RANK', disabled: !hasState || !!state?.done },
    { id: 'result', label: 'RESULT', disabled: !hasState },
  ];

  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';

  // Transient "Saved" tick shown only after the user clicks Save.
  //
  // Why we don't show "Saved" as a persistent status reflecting
  // the real autosave dirty signal: in practice every state change
  // is written within ~500ms (debounce) or instantaneously (force-
  // flush at the ≥10s / ≥20-comparison thresholds), so a faithful
  // dirty indicator barely flashes "💾 Save" at all — the user
  // sees "Saved" 99% of the time and the flip becomes visual
  // noise rather than useful feedback.
  //
  // Instead the button is a stable "💾 Save" affordance, and the
  // click produces an explicit "Saved ✓" tick for ~1.2s as a
  // morale-boost / "your action was acknowledged" signal. The
  // underlying save was probably already done by autosave; the
  // click still calls flushAutosave so any in-flight debounce is
  // committed synchronously, which makes the feedback truthful
  // in the technical sense too.
  const SAVED_TICK_MS = 1200;
  const [savedTick, setSavedTick] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  function handleSaveClick(): void {
    onSaveNow();
    setSavedTick(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedTick(false), SAVED_TICK_MS);
  }

  const saveDisabled = !hasState || !autosaveAvailable;
  const saveTitle = !autosaveAvailable
    ? 'Autosave unavailable on file:// — use Download'
    : 'Save now to in-browser storage';

  // -------- sliding tab indicator --------
  // Refs to each pill so we can measure the active one's offsetLeft + width
  // and slide a single accent <div> beneath them. A ResizeObserver on the
  // card handles font / viewport changes; activeTab dep handles tab clicks.
  const tabsCardRef = useRef<HTMLDivElement | null>(null);
  const pillRefs = useRef<Record<TabId, HTMLButtonElement | null>>({
    start: null,
    list: null,
    rank: null,
    result: null,
  });
  const [indicator, setIndicator] = useState<{ left: number; width: number }>({
    left: 0,
    width: 0,
  });

  useLayoutEffect(() => {
    function measure(): void {
      const card = tabsCardRef.current;
      const pill = pillRefs.current[activeTab];
      if (!card || !pill) return;
      // offsetLeft is already relative to the offsetParent, which for
      // position: relative .tabs-card is itself.
      setIndicator({ left: pill.offsetLeft, width: pill.offsetWidth });
    }
    measure();
    const card = tabsCardRef.current;
    if (!card || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    return () => ro.disconnect();
  }, [activeTab]);

  return (
    <header className="header">
      <div className="tabs-card-wrap">
        <div className="tabs-card" role="tablist" ref={tabsCardRef}>
          <div
            className="tab-indicator"
            style={{
              transform: `translateX(${indicator.left}px)`,
              width: indicator.width,
            }}
          />
          {tabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                pillRefs.current[t.id] = el;
              }}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`tab-pill ${activeTab === t.id ? 'active' : ''}`}
              disabled={t.disabled}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="header-toolbar">
        <div className="header-toolbar-left">
          <button
            className="toolbar-button"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo last action (↑)"
          >
            ↶ Undo
          </button>
        </div>
        <div className="header-toolbar-stats">{statText}</div>
        <div className="header-toolbar-right">
          <button
            className={`toolbar-button${savedTick ? ' saved' : ''}`}
            onClick={handleSaveClick}
            disabled={saveDisabled}
            title={saveTitle}
            aria-label={savedTick ? 'Saved' : 'Save now'}
          >
            {savedTick ? (
              <>
                <CheckIcon size={14} /> Saved
              </>
            ) : (
              <>
                <FloppyIcon size={14} /> Save
              </>
            )}
          </button>
          <button
            className="toolbar-button"
            onClick={onDownload}
            disabled={!hasState}
            title="Download active slot as a JSON file"
          >
            ⬇ Download
          </button>
          <button
            className="toolbar-button gear"
            onClick={onToggleTheme}
            title={themeBtnTitle}
            aria-label={themeBtnTitle}
          >
            {themeBtnGlyph}
          </button>
          <SettingsMenu
            autosaveAvailable={autosaveAvailable}
            onLoadFromFile={onLoadFromFile}
            onReset={onReset}
            onBackupAll={onBackupAll}
            onRestoreFromBackup={onRestoreFromBackup}
            hasActiveSlot={hasState}
            manifest={manifest}
            loadedSlotId={loadedSlotId}
            onSwitchSlot={onSwitchSlot}
            onDeleteSlot={onDeleteSlot}
            onRenameSlot={onRenameSlot}
            onDownloadSlot={onDownloadSlot}
            onTogglePinSlot={onTogglePinSlot}
            showEstimatedRemaining={showEstimatedRemaining}
            onToggleShowEstimatedRemaining={onToggleShowEstimatedRemaining}
            autoInsertEnabled={autoInsertEnabled}
            onToggleAutoInsertEnabled={onToggleAutoInsertEnabled}
            cloudStatus={cloudStatus}
            cloudFolderName={cloudFolderName}
            onCloudSignIn={onCloudSignIn}
            onCloudPickFolder={onCloudPickFolder}
            onCloudBrowse={onCloudBrowse}
            onCloudSignOut={onCloudSignOut}
            onCloudToggleOptIn={onCloudToggleOptIn}
            onCloudPushSlot={onCloudPushSlot}
            onCloudPullSlot={onCloudPullSlot}
            cloudPushingIds={cloudPushingIds}
            cloudPullingIds={cloudPullingIds}
          />
        </div>
      </div>
    </header>
  );
}
