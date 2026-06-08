import type { AnimeFilmographyRow } from '../lib/importers/anilist/graphQueries';
import { anilistUrlForStaff, bindAnilistMiddleClick, mergeAnilistLinkClass } from './anilistMiddleClick';
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
  staffId: number;
  staffName: string;
  rows: readonly AnimeFilmographyRow[];
  loading: boolean;
  onRefresh: () => void;
  onHopToAnime: (row: AnimeFilmographyRow) => void;
  /** Show the "only items on my list" filter — true when a cached AniList
   *  user list exists and this staff has filmography rows. */
  showMyListFilter?: boolean;
  onlyMyList?: boolean;
  onOnlyMyListChange?: (value: boolean) => void;
  /** True when none of this staff's filmography is on the user's list
   *  (drives the empty message, independent of the text filter). */
  myListEmpty?: boolean;
}

export function StaffFilmographySections({
  staffId,
  staffName,
  rows,
  loading,
  onRefresh,
  onHopToAnime,
  showMyListFilter = false,
  onlyMyList = false,
  onOnlyMyListChange,
  myListEmpty = false,
}: Props) {
  const { voice, production } = partitionFilmography(rows);
  const refreshLabel = 'Refresh filmography from AniList';
  const staffTitleLink = bindAnilistMiddleClick(anilistUrlForStaff({ id: staffId }));

  return (
    <>
      <div className="anime-to-anime-staff-heading">
        <h2
          className={mergeAnilistLinkClass(
            'anime-to-anime-current-title anime-to-anime-staff-heading-title',
            staffTitleLink.className,
          )}
          title={staffTitleLink.title}
          onMouseDown={staffTitleLink.onMouseDown}
          onAuxClick={staffTitleLink.onAuxClick}
        >
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

      {showMyListFilter && (
        <label className="anime-to-anime-my-list-toggle">
          <input
            type="checkbox"
            checked={onlyMyList}
            onChange={(e) => onOnlyMyListChange?.(e.target.checked)}
          />
          Only items on my list
        </label>
      )}

      {onlyMyList && myListEmpty && (
        <p className="settings-status anime-to-anime-empty-list">
          None of this person's works are on your list.
        </p>
      )}

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
