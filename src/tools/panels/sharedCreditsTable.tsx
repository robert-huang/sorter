import {
  anilistUrlForCharacter,
} from '../../lib/importers/anilist/anilistLinks';
import { AnilistMiddleClickLink } from '../../lib/importers/anilist/AnilistMiddleClickLink';
import {
  appendFavouriteStarBeforeRole,
  ToolShowButton,
  ToolStaffButton,
} from '../toolEntityLinks';
import { DragScroll } from '../../components/DragScroll';
import type { ToolPanelProps } from '../toolTypes';
import {
  expandSharedCreditsTableRows,
  type SharedCreditsTableRow,
  type StaffRoleEntry,
} from './sharedCreditsLogic';
import type { FavouriteEntityIds } from '../../lib/importers/anilist/readQueries';

function SharedCreditsRoleName({
  role,
  favourite,
}: {
  role: StaffRoleEntry;
  favourite: boolean;
}) {
  const anilistUrl =
    role.characterId != null ? anilistUrlForCharacter(role.characterId) : null;

  return (
    <AnilistMiddleClickLink
      url={anilistUrl}
      className={[
        'tool-character-name-link',
        role.characterId != null ? 'anilist-detail-character-name' : '',
        favourite ? 'anilist-detail-character-name--favourite' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {appendFavouriteStarBeforeRole(role.label, favourite)}
    </AnilistMiddleClickLink>
  );
}

export function SharedCreditsResultsTable({
  staffIds,
  staffNames,
  staffImages,
  rows,
  favourites,
  onOpenMedia,
  onOpenStaff,
}: {
  staffIds: number[];
  staffNames: string[];
  staffImages: Array<string | null>;
  rows: SharedCreditsTableRow[];
  favourites: FavouriteEntityIds;
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
                    favourite={favourites.staffIds.has(staffId)}
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
                      favourite={favourites.mediaIds.has(row.mediaId)}
                    />
                  </th>
                ) : null}
                {row.cells.map((role, colIdx) => (
                  <td key={`${row.mediaId}-${rowIndex}-${colIdx}`} className="tool-credits-role-col">
                    {role ? (
                      <SharedCreditsRoleName
                        role={role}
                        favourite={
                          role.characterId != null &&
                          favourites.characterIds.has(role.characterId)
                        }
                      />
                    ) : null}
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
