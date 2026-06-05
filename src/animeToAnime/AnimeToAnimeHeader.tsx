import { AnimeToAnimeSettingsMenu } from './AnimeToAnimeSettingsMenu';
import type { RoundConfig, VaListImageMode } from './preferences';
import type { AnimeToAnimeTheme } from './theme';

interface Props {
  theme: AnimeToAnimeTheme;
  vaListImageMode: VaListImageMode;
  roundConfig: RoundConfig;
  onToggleTheme: () => void;
  onVaListImageModeChange: (mode: VaListImageMode) => void;
  onRoundConfigChange: (patch: Partial<RoundConfig>) => void;
  titleInteractive?: boolean;
  onTitleClick?: () => void;
}

export function AnimeToAnimeHeader({
  theme,
  vaListImageMode,
  roundConfig,
  onToggleTheme,
  onVaListImageModeChange,
  onRoundConfigChange,
  titleInteractive = false,
  onTitleClick,
}: Props) {
  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';

  return (
    <header className="anime-to-anime-header header-toolbar">
      <div className="header-toolbar-left" />
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
          roundConfig={roundConfig}
          onRoundConfigChange={onRoundConfigChange}
        />
      </div>
    </header>
  );
}
