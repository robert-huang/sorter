import { AppNavFab } from '../components/AppNavFab';
import { SORTER_HOME_HREF } from '../lib/appRoutes';
import { AnimeToAnimeSettingsMenu } from './AnimeToAnimeSettingsMenu';
import type { SourceDbSyncControls } from '../hooks/useSourceDbSync';
import type { RoundConfig, StaffGenderFilter, VaListImageMode } from './preferences';
import type { AnimeToAnimeTheme } from './theme';

interface Props {
  theme: AnimeToAnimeTheme;
  vaListImageMode: VaListImageMode;
  staffGenderFilter: StaffGenderFilter;
  roundConfig: RoundConfig;
  dbSync: SourceDbSyncControls;
  onToggleTheme: () => void;
  onVaListImageModeChange: (mode: VaListImageMode) => void;
  onStaffGenderFilterChange: (filter: StaffGenderFilter) => void;
  onRoundConfigChange: (patch: Partial<RoundConfig>) => void;
  titleInteractive?: boolean;
  onTitleClick?: () => void;
}

export function AnimeToAnimeHeader({
  theme,
  vaListImageMode,
  staffGenderFilter,
  roundConfig,
  dbSync,
  onToggleTheme,
  onVaListImageModeChange,
  onStaffGenderFilterChange,
  onRoundConfigChange,
  titleInteractive = false,
  onTitleClick,
}: Props) {
  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';

  return (
    <header className="anime-to-anime-header header-toolbar">
      <div className="header-toolbar-left">
        <AppNavFab href={SORTER_HOME_HREF} label="← Sorter" title="Back to Sorter" />
      </div>
      {titleInteractive && onTitleClick ? (
        <button
          type="button"
          className="header-toolbar-stats anime-to-anime-header-title anime-to-anime-header-title--interactive"
          onClick={onTitleClick}
          title="Return to setup"
        >
          Anime to Anime
        </button>
      ) : (
        <div className="header-toolbar-stats anime-to-anime-header-title">Anime to Anime</div>
      )}
      <div className="header-toolbar-right">
        <button
          type="button"
          className="toolbar-button"
          onClick={onToggleTheme}
          title={themeBtnTitle}
          aria-label={themeBtnTitle}
        >
          {themeBtnGlyph}
        </button>
        <AnimeToAnimeSettingsMenu
          vaListImageMode={vaListImageMode}
          onVaListImageModeChange={onVaListImageModeChange}
          staffGenderFilter={staffGenderFilter}
          onStaffGenderFilterChange={onStaffGenderFilterChange}
          roundConfig={roundConfig}
          onRoundConfigChange={onRoundConfigChange}
          dbSync={dbSync}
        />
      </div>
    </header>
  );
}
