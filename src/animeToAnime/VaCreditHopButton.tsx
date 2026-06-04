import type { VaCreditRow } from '../lib/importers/anilist/graphQueries';
import type { VaListImageMode } from './preferences';
import {
  vaCreditListImage,
  vaCreditStaffName,
  vaCreditSubtitle,
} from './vaCreditDisplay';

interface Props {
  row: VaCreditRow;
  vaListImageMode: VaListImageMode;
  onHop: () => void;
}

export function VaCreditHopButton({ row, vaListImageMode, onHop }: Props) {
  const image = vaCreditListImage(row, vaListImageMode);
  const subtitle = vaCreditSubtitle(row);

  return (
    <button type="button" className="anime-to-anime-hop-btn" onClick={onHop}>
      {image && (
        <img className="anilist-detail-cast-image" src={image} alt="" loading="lazy" />
      )}
      <span className="anilist-detail-cast-text">
        <strong>{vaCreditStaffName(row)}</strong>
        {subtitle && <span className="anime-to-anime-hop-meta">{subtitle}</span>}
      </span>
    </button>
  );
}
