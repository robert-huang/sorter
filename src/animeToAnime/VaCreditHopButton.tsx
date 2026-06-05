import {
  anilistUrlForStaff,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';
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
  const anilistLink = bindAnilistMiddleClick(anilistUrlForStaff(group.staff));

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
        <strong>{vaCreditStaffNameFromStaff(group.staff)}</strong>
        {subtitle && <span className="anime-to-anime-hop-meta">{subtitle}</span>}
      </span>
    </button>
  );
}
