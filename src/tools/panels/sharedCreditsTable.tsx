import {
  anilistUrlForCharacter,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
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

export function SharedCreditsResultsTable({
  staffIds,
  staffNames,
  staffImages,
  rows,
  onOpenMedia,
  onOpenStaff,
}: {
  staffIds: number[];
  staffNames: string[];
  staffImages: Array<string | null>;
  rows: SharedCreditsTableRow[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
}) {
  return (
    <div className="tool-results tool-credits-table-outer">
      <div className="tool-credits-table-scroll">
        <table className="tool-result-table tool-credits-table">
          <thead>
            <tr>
              <th className="tool-credits-col-show"></th>
              {staffIds.map((staffId, index) => (
                <th key={staffId}>
                  <ToolStaffButton
                    staffId={staffId}
                    name={staffNames[index] ?? String(staffId)}
                    imageUrl={staffImages[index] ?? null}
                    onOpenStaff={onOpenStaff}
                    compact
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.mediaId}>
                <th className="tool-credits-col-show" scope="row">
                  <ToolShowButton
                    mediaId={row.mediaId}
                    title={row.title}
                    coverImage={row.coverImage}
                    onOpenMedia={onOpenMedia}
                    compact
                  />
                </th>
                {row.cells.map((roles, colIdx) => (
                  <td key={`${row.mediaId}-${colIdx}`} className="tool-credits-role-col">
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
