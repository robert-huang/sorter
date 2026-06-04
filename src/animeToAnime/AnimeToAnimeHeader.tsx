import type { AnimeToAnimeTheme } from './theme';

interface Props {
  theme: AnimeToAnimeTheme;
  onToggleTheme: () => void;
}

export function AnimeToAnimeHeader({ theme, onToggleTheme }: Props) {
  const themeBtnTitle =
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const themeBtnGlyph = theme === 'dark' ? '☾' : '☀';
  const sorterHref = `${import.meta.env.BASE_URL}index.html`;

  return (
    <header className="anime-to-anime-header header-toolbar">
      <div className="header-toolbar-left">
        <a className="anime-to-anime-back-link" href={sorterHref}>
          ← Sorter
        </a>
      </div>
      <div className="header-toolbar-stats anime-to-anime-header-title">Anime to Anime</div>
      <div className="header-toolbar-right">
        <button
          type="button"
          className="toolbar-button gear"
          onClick={onToggleTheme}
          title={themeBtnTitle}
          aria-label={themeBtnTitle}
        >
          {themeBtnGlyph}
        </button>
      </div>
    </header>
  );
}
