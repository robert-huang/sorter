import type { AnimeFilmographyRow } from '../lib/importers/anilist/graphQueries';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
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
        {row.creditKind === 'production' ? (
          row.roles.length > 0 && (
            <ul className="anime-to-anime-hop-role-list">
              {row.roles.map((role) => (
                <li key={role}>{role}</li>
              ))}
            </ul>
          )
        ) : (
          row.roles.length > 0 && (
            <span className="anime-to-anime-hop-meta">{row.roles.join(', ')}</span>
          )
        )}
      </span>
    </button>
  );
}
