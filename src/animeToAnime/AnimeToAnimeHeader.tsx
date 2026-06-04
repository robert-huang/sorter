import { AnimeToAnimeSettingsMenu } from './AnimeToAnimeSettingsMenu';
import type { VaListImageMode } from './preferences';
import type { AnimeToAnimeTheme } from './theme';

interface Props {
  theme: AnimeToAnimeTheme;
  vaListImageMode: VaListImageMode;
  onToggleTheme: () => void;
  onVaListImageModeChange: (mode: VaListImageMode) => void;
}

export function AnimeToAnimeHeader({
  theme,
  vaListImageMode,
  onToggleTheme,
  onVaListImageModeChange,
}: Props) {
  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';

  return (
    <header className="anime-to-anime-header header-toolbar">
      <div className="header-toolbar-left" />
      <div className="header-toolbar-stats anime-to-anime-header-title">Anime to Anime</div>
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
        />
      </div>
    </header>
  );
}
