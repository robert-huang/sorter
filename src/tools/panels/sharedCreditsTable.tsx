import {
  anilistUrlForCharacter,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../../lib/importers/anilist/anilistLinks';
import { ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import type { ToolPanelProps } from '../toolTypes';
import {
  expandSharedCreditsTableRows,
  type SharedCreditsTableRow,
  type StaffRoleEntry,
} from './sharedCreditsLogic';

function SharedCreditsRoleName({ role }: { role: StaffRoleEntry }) {
  const anilistUrl =
    role.characterId != null ? anilistUrlForCharacter(role.characterId) : null;
  const anilistLink = bindAnilistMiddleClick(anilistUrl);

  if (!anilistLink.className) {
    return <span>{role.label}</span>;
  }

  return (
    <span
      className={mergeAnilistLinkClass('tool-character-name-link', anilistLink.className)}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
    >
      {role.label}
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
  const physicalRows = expandSharedCreditsTableRows(rows);

  return (
    <div className="tool-results tool-credits-table-outer">
      <DragScroll className="tool-credits-table-scroll">
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
            {physicalRows.map((row, rowIndex) => (
              <tr key={`${row.mediaId}-${rowIndex}`}>
                {!row.showSkipRender ? (
                  <th
                    className="tool-credits-col-show"
                    scope="row"
                    rowSpan={row.showRowSpan}
                  >
                    <ToolShowButton
                      mediaId={row.mediaId}
                      title={row.title}
                      coverImage={row.coverImage}
                      onOpenMedia={onOpenMedia}
                      compact
                    />
                  </th>
                ) : null}
                {row.cells.map((role, colIdx) => (
                  <td key={`${row.mediaId}-${rowIndex}-${colIdx}`} className="tool-credits-role-col">
                    {role ? <SharedCreditsRoleName role={role} /> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </DragScroll>
    </div>
  );
}
