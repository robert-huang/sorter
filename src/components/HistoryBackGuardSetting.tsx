interface Props {
  enabled: boolean;
  onToggle: () => void;
}

/** Footer checkbox shared by Sorter and Anime to Anime gear menus. */
export function HistoryBackGuardSetting({ enabled, onToggle }: Props) {
  return (
    <label className="settings-status settings-footer-toggle">
      <input type="checkbox" checked={enabled} onChange={onToggle} />
      <span>Block browser back during work in progress</span>
    </label>
  );
}
