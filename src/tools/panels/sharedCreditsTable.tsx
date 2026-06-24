import {
  anilistUrlForCharacter,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import type { ToolPanelProps } from '../toolTypes';
import type { SharedCreditsTableRow, StaffRoleEntry } from './sharedCreditsLogic';

function SharedCreditsRoleName({ role }: { role: StaffRoleEntry }) {
  const anilistUrl =
    role.characterId != null ? anilistUrlForCharacter(role.characterId) : null;
  const anilistLink = bindAnilistMiddleClick(anilistUrl);

  if (!anilistLink.className) {
    return <span>{role.label}</span>;
  }

  return (
    <span
      className={mergeAnilistLinkClass(
        'anilist-detail-character-name',
        anilistLink.className,
      )}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      {role.label}
    </span>
  );
}

function SharedCreditsRoleCell({ roles }: { roles: StaffRoleEntry[] }) {
  if (roles.length === 0) {
    return null;
  }
  return (
    <span className="tool-credits-role-cell">
      {roles.map((role, index) => (
        <span key={`${role.label}-${index}`}>
          {index > 0 ? ', ' : null}
          <SharedCreditsRoleName role={role} />
        </span>
      ))}
    </span>
  );
}

function SharedCreditsShowCell({
  mediaId,
  title,
  coverImage,
  onOpenMedia,
}: {
  mediaId: number;
  title: string;
  coverImage: string | null;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <button
      type="button"
      className="tool-credits-show-btn"
      onClick={() => onOpenMedia(mediaId, title, { forceRefresh: true })}
    >
      {coverImage ? (
        <img src={coverImage} alt="" className="tool-credits-show-poster" />
      ) : (
        <span className="tool-credits-show-poster tool-credits-show-poster-placeholder" />
      )}
      <span className="tool-credits-show-title">{title}</span>
    </button>
  );
}

export function SharedCreditsResultsTable({
  staffNames,
  rows,
  onOpenMedia,
}: {
  staffNames: string[];
  rows: SharedCreditsTableRow[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <div className="tool-results tool-credits-table-outer">
      <div className="tool-credits-table-scroll">
        <table className="tool-result-table tool-credits-table">
          <thead>
            <tr>
              <th className="tool-credits-col-show">Show</th>
              {staffNames.map((name) => (
                <th key={name}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mediaId}>
                <th className="tool-credits-col-show" scope="row">
                  <SharedCreditsShowCell
                    mediaId={row.mediaId}
                    title={row.title}
                    coverImage={row.coverImage}
                    onOpenMedia={onOpenMedia}
                  />
                </th>
                {row.cells.map((roles, colIdx) => (
                  <td key={`${row.mediaId}-${colIdx}`}>
                    <SharedCreditsRoleCell roles={roles} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
