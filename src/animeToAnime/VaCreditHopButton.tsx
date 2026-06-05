import type { VaListImageMode } from './preferences';
import {
  groupedVaCreditSubtitle,
  vaCreditListImage,
  vaCreditStaffNameFromStaff,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';

interface Props {
  group: GroupedVaCreditRow;
  vaListImageMode: VaListImageMode;
  onHop: () => void;
}

export function VaCreditHopButton({ group, vaListImageMode, onHop }: Props) {
  const primaryCredit = group.credits[0];
  const image = vaCreditListImage(primaryCredit, vaListImageMode);
  const subtitle = groupedVaCreditSubtitle(group);

  return (
    <button type="button" className="anime-to-anime-hop-btn" onClick={onHop}>
      {image && (
        <img className="anime-to-anime-hop-image" src={image} alt="" loading="lazy" />
      )}
      <span className="anilist-detail-cast-text">
        <strong>{vaCreditStaffNameFromStaff(group.staff)}</strong>
        {subtitle && <span className="anime-to-anime-hop-meta">{subtitle}</span>}
      </span>
    </button>
  );
}
