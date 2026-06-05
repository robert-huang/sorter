import type { AnimeFilmographyRow } from '../lib/importers/anilist/graphQueries';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { filmographyRolesSubtitle } from './vaCreditDisplay';
import {
  anilistUrlForMedia,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';

interface Props {
  row: AnimeFilmographyRow;
  onHop: () => void;
}

export function AnimeFilmographyHopButton({ row, onHop }: Props) {
  const title = pickMediaTitle(row.media);
  const cover = row.media.cover_image;
  const rolesLine = filmographyRolesSubtitle(row);
  const anilistLink = bindAnilistMiddleClick(anilistUrlForMedia(row.media));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass('anime-to-anime-hop-btn', anilistLink.className)}
      title={anilistLink.title}
      onClick={onHop}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      {cover && (
        <img className="anime-to-anime-hop-image" src={cover} alt="" loading="lazy" />
      )}
      <span className="anilist-detail-cast-text">
        <strong>{title}</strong>
        {rolesLine && <span className="anime-to-anime-hop-meta">{rolesLine}</span>}
      </span>
    </button>
  );
}
