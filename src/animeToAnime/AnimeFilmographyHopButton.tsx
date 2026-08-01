import type { AnimeFilmographyRow } from '../lib/importers/anilist/graphQueries';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { filmographyRolesSubtitle } from './vaCreditDisplay';
import { anilistUrlForMedia, AnilistMiddleClickLink } from './anilistMiddleClick';

interface Props {
  row: AnimeFilmographyRow;
  onHop: () => void;
}

export function AnimeFilmographyHopButton({ row, onHop }: Props) {
  const title = pickMediaTitle(row.media);
  const cover = row.media.cover_image;
  const rolesLine = filmographyRolesSubtitle(row);

  return (
    <AnilistMiddleClickLink
      url={anilistUrlForMedia(row.media)}
      className="anime-to-anime-hop-btn"
      onPrimaryClick={onHop}
    >
      {cover && (
        <img className="anime-to-anime-hop-image" src={cover} alt="" loading="lazy" />
      )}
      <span className="anilist-detail-cast-text">
        <strong>{title}</strong>
        {rolesLine && <span className="anime-to-anime-hop-meta">{rolesLine}</span>}
      </span>
    </AnilistMiddleClickLink>
  );
}
