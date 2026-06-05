import type { ProductionCreditRow } from '../lib/importers/anilist/graphQueries';
import {
  anilistUrlForStaff,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';

interface Props {
  row: ProductionCreditRow;
  onHop: () => void;
}

function productionStaffName(row: ProductionCreditRow): string {
  return row.staff.name_full ?? row.staff.name_native ?? `Staff #${row.staff.id}`;
}

export function ProductionCreditHopButton({ row, onHop }: Props) {
  const name = productionStaffName(row);
  const image = row.staff.image;
  const anilistLink = bindAnilistMiddleClick(anilistUrlForStaff(row.staff));

  return (
    <button
      type="button"
      className={mergeAnilistLinkClass('anime-to-anime-hop-btn', anilistLink.className)}
      title={anilistLink.title}
      onClick={onHop}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      {image && (
        <img className="anime-to-anime-hop-image" src={image} alt="" loading="lazy" />
      )}
      <span className="anilist-detail-cast-text">
        <strong>{name}</strong>
        {row.roles.length > 0 && (
          <span className="anime-to-anime-hop-meta">{row.roles.join(', ')}</span>
        )}
      </span>
    </button>
  );
}
