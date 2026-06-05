import { useEffect, useRef, useState } from 'react';
import type { RoundConfig, VaListImageMode } from './preferences';

interface Props {
  vaListImageMode: VaListImageMode;
  onVaListImageModeChange: (mode: VaListImageMode) => void;
  roundConfig: RoundConfig;
  onRoundConfigChange: (patch: Partial<RoundConfig>) => void;
}

export function AnimeToAnimeSettingsMenu({
  vaListImageMode,
  onVaListImageModeChange,
  roundConfig,
  onRoundConfigChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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
    </div>
  );
}
