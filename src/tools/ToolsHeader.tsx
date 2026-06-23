import { AppNavFab } from '../components/AppNavFab';
import { ANIME_TO_ANIME_HREF } from '../lib/appRoutes';
import type { SourceDbSyncControls } from '../hooks/useSourceDbSync';
import type { AnimeToAnimeTheme } from '../animeToAnime/theme';
import { ToolsSettingsMenu } from './ToolsSettingsMenu';

interface Props {
  theme: AnimeToAnimeTheme;
  onToggleTheme: () => void;
  historyBackGuard: boolean;
  onToggleHistoryBackGuard: () => void;
  dbSync: SourceDbSyncControls;
}

/** Top toolbar for the Tools app. A2A is the nav hub, so Tools carries a
 *  single `← A2A` cross-link back (Sorter↔Tools is a 2-hop trip through A2A). */
export function ToolsHeader({
  theme,
  onToggleTheme,
  historyBackGuard,
  onToggleHistoryBackGuard,
  dbSync,
}: Props) {
  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';

  return (
    <header className="anime-to-anime-header header-toolbar">
      <div className="header-toolbar-left">
        <AppNavFab
          href={ANIME_TO_ANIME_HREF}
          label="← A2A"
          title="Back to Anime to Anime"
        />
      </div>
      <div className="header-toolbar-stats anime-to-anime-header-title">
        Anime Tools
      </div>
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
        <ToolsSettingsMenu
          historyBackGuard={historyBackGuard}
          onToggleHistoryBackGuard={onToggleHistoryBackGuard}
          dbSync={dbSync}
        />
      </div>
    </header>
  );
}
