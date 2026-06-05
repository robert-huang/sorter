import type { AnimeFilmographyRow } from '../lib/importers/anilist/graphQueries';
import { AnimeFilmographyHopButton } from './AnimeFilmographyHopButton';

function partitionFilmography(rows: readonly AnimeFilmographyRow[]): {
  voice: AnimeFilmographyRow[];
  production: AnimeFilmographyRow[];
} {
  const voice: AnimeFilmographyRow[] = [];
  const production: AnimeFilmographyRow[] = [];
  for (const row of rows) {
    if (row.creditKind === 'voice') {
      voice.push(row);
    } else {
      production.push(row);
    }
  }
  return { voice, production };
}

function FilmographyList({
  rows,
  onHopToAnime,
}: {
  rows: readonly AnimeFilmographyRow[];
  onHopToAnime: (row: AnimeFilmographyRow) => void;
}) {
  return (
    <ul className="anime-to-anime-hop-list">
      {rows.map((row) => (
        <li
          key={`${row.media.id}-${row.creditKind}-${row.roles.join('|')}`}
          className="anime-to-anime-hop-list-item"
        >
          <AnimeFilmographyHopButton row={row} onHop={() => onHopToAnime(row)} />
        </li>
      ))}
    </ul>
  );
}

interface Props {
  staffName: string;
  rows: readonly AnimeFilmographyRow[];
  loading: boolean;
  onRefresh: () => void;
  onHopToAnime: (row: AnimeFilmographyRow) => void;
}

export function StaffFilmographySections({
  staffName,
  rows,
  loading,
  onRefresh,
  onHopToAnime,
}: Props) {
  const { voice, production } = partitionFilmography(rows);
  const refreshLabel = 'Refresh filmography from AniList';

  return (
    <>
      <div className="anime-to-anime-staff-heading">
        <h2 className="anime-to-anime-current-title anime-to-anime-staff-heading-title">
          {staffName}
        </h2>
        <button
          type="button"
          className="btn icon-only anime-to-anime-refresh-btn anime-to-anime-refresh-btn--compact"
          onClick={onRefresh}
          disabled={loading}
          title={refreshLabel}
          aria-label={refreshLabel}
        >
          ↻
        </button>
      </div>

      {voice.length > 0 && (
        <section className="anime-to-anime-filmography-section">
          <h3 className="anime-to-anime-subheading">Anime Voice Roles</h3>
          <FilmographyList rows={voice} onHopToAnime={onHopToAnime} />
        </section>
      )}

      {production.length > 0 && (
        <section className="anime-to-anime-filmography-section">
          <h3 className="anime-to-anime-subheading">Anime Staff Roles</h3>
          <FilmographyList rows={production} onHopToAnime={onHopToAnime} />
        </section>
      )}
    </>
  );
}
