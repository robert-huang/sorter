import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AddItemsModal,
  type AddItemsModalTab,
} from '../../components/AddItemsModal';
import {
  EditItemModal,
  type EditItemSavePayload,
} from '../../components/EditItemModal';
import { Modal } from '../../components/Modal';
import {
  StagedItemsPanel,
  type StagedGroup,
  type StagedRemovalMarkers,
} from '../../components/StagedItemsPanel';
import { AnilistMiddleClickLink } from '../../lib/importers/anilist/AnilistMiddleClickLink';
import { applyCachedAnilistItemEdit } from '../../lib/importers/anilist/anilistItemMaterialization';
import type { Item } from '../../lib/types';
import type { OrderedSlotImport } from '../../components/SortResultsImportMode';
import type { ToolPanelProps } from '../toolTypes';
import { useToolsPreferences } from '../../hooks/useToolsPreferences';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import {
  BUMP_CHART_COLORS,
  buildBumpTimeline,
  bumpConnectionMovement,
  bumpRowCenterOffsets,
  bumpItemsFromImportedItems,
  bumpItemsFromSortResults,
  dedupeBumpChartItems,
  displayBumpChartItems,
  hasCustomAnilistLabels,
  hydrateBumpChartItems,
  type BumpChartItem,
  type BumpConnection,
  type BumpTimelineSegment,
} from './bumpChartLogic';
import {
  BUMP_CHART_SLOT_LIMIT,
  deleteSavedBumpChart,
  initializeBumpChartStorage,
  listSavedBumpCharts,
  refreshBumpChartStorage,
  loadActiveBumpChartWorkspace,
  loadSavedBumpChart,
  saveActiveBumpChartWorkspace,
  saveNamedBumpChart,
  type BumpChartColumnSnapshot,
  type BumpChartSideSnapshot,
  type BumpChartWorkspaceSnapshot,
  type SaveNamedBumpChartResult,
  type SavedBumpChartMeta,
} from './bumpChartStorage';
import {
  STATE_REVISION_KEY,
  getStateStorageStatus,
  getStateWriterId,
} from '../../lib/stateStorageDb';
import {
  loadCachedCanvasImage,
  type LoadedCanvasImage,
} from './bumpChartImageCache';
import {
  isAnilistCdnImageUrl,
  resolveBumpMalExportImage,
} from './bumpChartMalExportImages';

type ChartSide = 'left' | 'right';

type BumpStageGroup = {
  id: string;
  source: string;
  items: BumpChartItem[];
} & StagedRemovalMarkers;

type BumpSideDraft = {
  groups: BumpStageGroup[];
  preserveCustomLabels: boolean;
};

type BumpColumnDraft = {
  id: string;
  kind: 'previous' | 'current';
  name?: string;
  draft: BumpSideDraft;
};

type GeneratedBumpColumn = {
  id: string;
  kind: 'previous' | 'current';
  name?: string;
  items: BumpChartItem[];
  hiddenItemIds: Set<string>;
  preserveCustomLabels: boolean;
};

type GeneratedBumpChart = {
  columns: GeneratedBumpColumn[];
};

type EditTarget =
  | {
      scope: 'draft';
      columnId: string;
      groupId: string;
      index: number;
      item: Item;
    }
  | {
      scope: 'chart';
      columnId: string;
      index: number;
      item: Item;
    };

let nextStageId = 1;
let nextColumnId = 2;

function stageId(): string {
  const id = nextStageId;
  nextStageId += 1;
  return `bump-stage-${id}`;
}

function columnId(existingIds: ReadonlySet<string>): string {
  while (existingIds.has(`previous-${nextColumnId}`)) {
    nextColumnId += 1;
  }
  const id = `previous-${nextColumnId}`;
  nextColumnId += 1;
  return id;
}

function emptyDraft(): BumpSideDraft {
  return { groups: [], preserveCustomLabels: false };
}

function defaultDraftColumns(): BumpColumnDraft[] {
  return [
    { id: 'previous-1', kind: 'previous', draft: emptyDraft() },
    { id: 'current', kind: 'current', draft: emptyDraft() },
  ];
}

function orderFallbackLabel(columnIndex: number, columnCount: number): string {
  if (columnIndex === columnCount - 1) return 'Current order';
  return columnCount === 2
    ? 'Previous order'
    : `Previous order ${columnIndex + 1}`;
}

function itemsInDraft(draft: BumpSideDraft): BumpChartItem[] {
  return dedupeBumpChartItems(
    draft.groups.map((group) =>
      group.markedForRemoval
        ? []
        : group.items.filter(
            (entry) => !group.markedItemIds?.has(entry.item.id),
          ),
    ),
  );
}

function draftToSnapshot(draft: BumpSideDraft): BumpChartSideSnapshot {
  const items: BumpChartItem[] = [];
  const hiddenItemIds: string[] = [];
  const seen = new Set<string>();
  draft.groups.forEach((group) => {
    group.items.forEach((entry) => {
      const id = entry.item.id;
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      items.push(entry);
      if (group.markedForRemoval || group.markedItemIds?.has(id)) {
        hiddenItemIds.push(id);
      }
    });
  });
  return {
    items,
    hiddenItemIds,
    preserveCustomLabels: draft.preserveCustomLabels,
  };
}

function chartColumnToSnapshot(
  column: GeneratedBumpColumn,
): BumpChartColumnSnapshot {
  return {
    id: column.id,
    kind: column.kind,
    ...(column.name ? { name: column.name } : {}),
    items: column.items,
    hiddenItemIds: [...column.hiddenItemIds],
    preserveCustomLabels: column.preserveCustomLabels,
  };
}

function draftFromSnapshot(
  snapshot: BumpChartSideSnapshot,
  source: string,
): BumpSideDraft {
  return {
    groups:
      snapshot.items.length === 0
        ? []
        : [
            {
              id: stageId(),
              source,
              items: snapshot.items,
              markedItemIds: new Set(snapshot.hiddenItemIds),
            },
          ],
    preserveCustomLabels: snapshot.preserveCustomLabels,
  };
}

function chartFromSnapshot(
  workspace: BumpChartWorkspaceSnapshot,
): GeneratedBumpChart {
  return {
    columns: workspace.columns.map((column) => ({
      id: column.id,
      kind: column.kind,
      ...(column.name ? { name: column.name } : {}),
      items: column.items,
      hiddenItemIds: new Set(column.hiddenItemIds),
      preserveCustomLabels: column.preserveCustomLabels,
    })),
  };
}

function workspaceFromState(
  columns: readonly BumpColumnDraft[],
  chart: GeneratedBumpChart | null,
  bestMatchByTitle: boolean,
  lastImportTab: AddItemsModalTab,
): BumpChartWorkspaceSnapshot {
  return {
    version: 2,
    view: chart ? 'chart' : 'staging',
    columns: chart
      ? chart.columns.map(chartColumnToSnapshot)
      : columns.map((column) => ({
          ...draftToSnapshot(column.draft),
          id: column.id,
          kind: column.kind,
          ...(column.name ? { name: column.name } : {}),
        })),
    bestMatchByTitle,
    lastImportTab,
  };
}

export function applyBumpChartItemEdit(
  entry: BumpChartItem,
  payload: EditItemSavePayload,
): BumpChartItem {
  const item = applyCachedAnilistItemEdit(entry.item, payload);
  return {
    ...entry,
    item,
    logicalId: payload.id != null ? item.id : entry.logicalId,
  };
}

function otherItemIds(
  target: EditTarget,
  columns: readonly BumpColumnDraft[],
  chart: GeneratedBumpChart | null,
): Map<string, string> {
  const ids = new Map<string, string>();
  if (target.scope === 'draft') {
    const draft = columns.find(({ id }) => id === target.columnId)?.draft;
    if (!draft) return ids;
    draft.groups.forEach((group) => {
      group.items.forEach((entry, index) => {
        if (
          (group.id !== target.groupId || index !== target.index) &&
          entry.item.id !== target.item.id
        ) {
          ids.set(entry.item.id, entry.item.label);
        }
      });
    });
    return ids;
  }
  const entries =
    chart?.columns.find(({ id }) => id === target.columnId)?.items ?? [];
  entries.forEach((entry, index) => {
    if (index !== target.index && entry.item.id !== target.item.id) {
      ids.set(entry.item.id, entry.item.label);
    }
  });
  return ids;
}

function canOpenDetail(item: Item): boolean {
  return (
    item.source?.kind === 'anilist' ||
    item.source?.kind === 'anilist-staff'
  );
}

function openItemDetail(item: Item, panelProps: ToolPanelProps): void {
  if (item.source?.kind === 'anilist') {
    panelProps.onOpenMedia(item.source.externalId, item.label);
  } else if (item.source?.kind === 'anilist-staff') {
    panelProps.onOpenStaff(item.source.externalId, item.label);
  }
}

function InteractiveItemLabel({
  item,
  side,
  panelProps,
  onPrimaryClick,
}: {
  item: Item;
  side: ChartSide;
  panelProps: ToolPanelProps;
  onPrimaryClick?: () => void;
}) {
  return (
    <AnilistMiddleClickLink
      url={item.url ?? null}
      className={`bump-chart-item-link bump-chart-item-link--${side}`}
      onPrimaryClick={
        onPrimaryClick ??
        (canOpenDetail(item)
          ? () => openItemDetail(item, panelProps)
          : undefined)
      }
      title={
        canOpenDetail(item)
          ? `${item.label} (middle-click to open source)`
          : item.label
      }
      data-bump-item-id={item.id}
    >
      {item.imageUrl && <img src={item.imageUrl} alt="" loading="lazy" />}
      <span className="bump-chart-label">{item.label}</span>
    </AnilistMiddleClickLink>
  );
}

function BumpStage({
  title,
  name,
  draft,
  onRename,
  onImport,
  onRemoveGroup,
  onRemoveItem,
  onEditItem,
  onOpenItemDetail,
  onTogglePreserveCustomLabels,
  onClearAll,
  headingActions,
}: {
  title: string;
  name?: string;
  draft: BumpSideDraft;
  onRename: (name: string | undefined) => void;
  onImport: () => void;
  onRemoveGroup: (groupId: string) => void;
  onRemoveItem: (groupId: string, index: number) => void;
  onEditItem: (groupId: string, index: number, item: Item) => void;
  onOpenItemDetail: (item: Item) => void;
  onTogglePreserveCustomLabels: () => void;
  onClearAll: () => void;
  headingActions?: ReactNode;
}) {
  const deduped = itemsInDraft(draft);
  const hasCustomLabels = hasCustomAnilistLabels(deduped);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(name ?? '');
  useEffect(() => {
    if (!editingName) setNameDraft(name ?? '');
  }, [editingName, name]);
  const commitName = (): void => {
    const nextName = nameDraft.trim();
    if (nextName !== (name ?? '')) {
      onRename(nextName || undefined);
    }
    setEditingName(false);
  };
  const stagedGroups: StagedGroup[] = draft.groups.map((group) => ({
    id: group.id,
    kind: 'sublist',
    source: group.source,
    items: displayBumpChartItems(
      group.items,
      draft.preserveCustomLabels,
    ).map((entry) => entry.item),
    markedForRemoval: group.markedForRemoval,
    markedItemIds: group.markedItemIds,
  }));

  return (
    <section className="tool-form-card bump-chart-import-card">
      <div className="bump-chart-import-heading">
        <div>
          <h3>
            {editingName ? (
              <input
                className="bump-chart-order-name-input"
                aria-label={`Name ${title}`}
                value={nameDraft}
                maxLength={200}
                autoFocus
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={commitName}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setNameDraft(name ?? '');
                    setEditingName(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="bump-chart-order-name-button"
                aria-label={`Rename ${title}`}
                title={`Rename ${title}`}
                onClick={() => setEditingName(true)}
              >
                {name ?? title}
              </button>
            )}
          </h3>
          <p>Each import is appended in pre-ranked order.</p>
        </div>
        {headingActions && (
          <div className="bump-chart-import-heading-actions">
            {headingActions}
          </div>
        )}
        <button type="button" className="btn primary" onClick={onImport}>
          Import ranked items
        </button>
      </div>

      {hasCustomLabels && (
        <div className="bump-chart-import-action-row">
          <label
            className="checkbox-row bump-chart-preserve-labels"
            title="When off, hydrated AniList items use the current display-language setting."
          >
            <input
              type="checkbox"
              checked={draft.preserveCustomLabels}
              onChange={onTogglePreserveCustomLabels}
            />
            Preserve custom labels
          </label>
        </div>
      )}

      <div className="bump-chart-staging-area">
        <div className="bump-chart-staging-heading">
          <div className="bump-chart-staging-title">Staging area</div>
          <span className="bump-chart-stage-count">
            {deduped.length} staged
          </span>
        </div>
        <StagedItemsPanel
          staged={stagedGroups}
          pending={[]}
          showStartControls={false}
          variant="bump-chart"
          ariaLabel={`${title} staged ranked lists`}
          emptyHint="No ranked lists staged yet."
          onClearAll={onClearAll}
          onToggleRemoveGroup={onRemoveGroup}
          onToggleRemoveItem={(groupId, _itemId, index) => {
            if (index != null) onRemoveItem(groupId, index);
          }}
          onEditItem={(groupId, _itemId, index) => {
            const entry =
              index == null
                ? undefined
                : draft.groups
                    .find((group) => group.id === groupId)
                    ?.items[index];
            if (entry && index != null) {
              onEditItem(groupId, index, entry.item);
            }
          }}
          onOpenItemDetail={onOpenItemDetail}
        />
      </div>
    </section>
  );
}

type ChartLayout = {
  width: number;
  height: number;
  columnXs: number[];
  centersByColumn: number[][];
  eventBoundsByColumn: Array<
    Array<{ left: number; right: number } | null>
  >;
};

const BUMP_ENDPOINT_NODE_GUTTER = 12;

export function bumpTimelineColumnAnchorX(
  columnIndex: number,
  columnCount: number,
  rootLeft: number,
  cellRect: Pick<DOMRect, 'left' | 'right' | 'width'>,
): number {
  if (columnIndex === 0) {
    return cellRect.right - rootLeft + BUMP_ENDPOINT_NODE_GUTTER;
  }
  if (columnIndex === columnCount - 1) {
    return cellRect.left - rootLeft - BUMP_ENDPOINT_NODE_GUTTER;
  }
  return cellRect.left - rootLeft + cellRect.width / 2;
}

function sameLayout(a: ChartLayout | null, b: ChartLayout): boolean {
  return (
    a?.width === b.width &&
    a.height === b.height &&
    a.columnXs.length === b.columnXs.length &&
    a.centersByColumn.length === b.centersByColumn.length &&
    a.eventBoundsByColumn.length === b.eventBoundsByColumn.length &&
    a.columnXs.every((value, index) => value === b.columnXs[index]) &&
    a.centersByColumn.every(
      (centers, columnIndex) =>
        centers.length === b.centersByColumn[columnIndex]?.length &&
        centers.every(
          (value, itemIndex) =>
            value === b.centersByColumn[columnIndex]?.[itemIndex],
        ),
    ) &&
    a.eventBoundsByColumn.every(
      (bounds, columnIndex) =>
        bounds.length === b.eventBoundsByColumn[columnIndex]?.length &&
        bounds.every((value, itemIndex) => {
          const other = b.eventBoundsByColumn[columnIndex]?.[itemIndex];
          return (
            value?.left === other?.left && value?.right === other?.right
          );
        }),
    )
  );
}

export function bumpTimelinePathEndpoints(
  leftAnchorX: number,
  rightAnchorX: number,
  leftEventBounds: { left: number; right: number } | null,
  rightEventBounds: { left: number; right: number } | null,
): { startX: number; endX: number } {
  return {
    startX: leftEventBounds?.right ?? leftAnchorX,
    endX: rightEventBounds?.left ?? rightAnchorX,
  };
}

export function bumpTimelinePathMidpoint(
  leftAnchorX: number,
  rightAnchorX: number,
  leftEventBounds: { left: number; right: number } | null,
  rightEventBounds: { left: number; right: number } | null,
  leftY: number,
  rightY: number,
): { x: number; y: number } {
  const { startX, endX } = bumpTimelinePathEndpoints(
    leftAnchorX,
    rightAnchorX,
    leftEventBounds,
    rightEventBounds,
  );
  return {
    x: (startX + endX) / 2,
    y: (leftY + rightY) / 2,
  };
}

function eventBounds(
  layout: ChartLayout,
  columnIndex: number,
  itemIndex: number,
): { left: number; right: number } | null {
  return layout.eventBoundsByColumn[columnIndex]?.[itemIndex] ?? null;
}

function timelineMovementPath(
  connection: BumpTimelineSegment,
  layout: ChartLayout,
): string {
  const leftX = layout.columnXs[connection.pairIndex] ?? 0;
  const rightX = layout.columnXs[connection.pairIndex + 1] ?? 0;
  const leftY =
    connection.leftIndex == null
      ? null
      : layout.centersByColumn[connection.pairIndex]?.[
          connection.leftIndex
        ] ?? 0;
  const rightY =
    connection.rightIndex == null
      ? null
      : layout.centersByColumn[connection.pairIndex + 1]?.[
          connection.rightIndex
        ] ?? 0;
  if (connection.kind === 'removed') {
    const bounds = eventBounds(
      layout,
      connection.pairIndex,
      connection.leftIndex!,
    );
    const startX = bounds?.right ?? leftX;
    return `M ${startX} ${leftY} L ${startX + (bounds ? 30 : 42)} ${leftY}`;
  }
  if (connection.kind === 'added') {
    const bounds = eventBounds(
      layout,
      connection.pairIndex + 1,
      connection.rightIndex!,
    );
    const endX = bounds?.left ?? rightX;
    return `M ${endX - (bounds ? 30 : 42)} ${rightY} L ${endX} ${rightY}`;
  }
  const { startX, endX } = bumpTimelinePathEndpoints(
    leftX,
    rightX,
    eventBounds(layout, connection.pairIndex, connection.leftIndex!),
    eventBounds(layout, connection.pairIndex + 1, connection.rightIndex!),
  );
  const control = (endX - startX) * 0.42;
  return `M ${startX} ${leftY} C ${startX + control} ${leftY}, ${
    endX - control
  } ${rightY}, ${endX} ${rightY}`;
}

function changeMarkerX(
  connection: BumpTimelineSegment,
  layout: ChartLayout,
): number {
  if (connection.kind === 'removed') {
    const anchor = layout.columnXs[connection.pairIndex] ?? 0;
    const bounds = eventBounds(
      layout,
      connection.pairIndex,
      connection.leftIndex!,
    );
    return bounds ? bounds.right + 45 : anchor + 55;
  }
  const anchor = layout.columnXs[connection.pairIndex + 1] ?? 0;
  const bounds = eventBounds(
    layout,
    connection.pairIndex + 1,
    connection.rightIndex!,
  );
  return bounds ? bounds.left - 45 : anchor - 55;
}

function ChangeMarker({
  kind,
  x,
  y,
}: {
  kind: 'removed' | 'added';
  x: number;
  y: number;
}) {
  return (
    <g className={`bump-chart-change-marker bump-chart-change-marker--${kind}`}>
      <circle cx={x} cy={y} r="10" />
      {kind === 'added' ? (
        <>
          <line x1={x - 4.5} y1={y} x2={x + 4.5} y2={y} />
          <line x1={x} y1={y - 4.5} x2={x} y2={y + 4.5} />
        </>
      ) : (
        <>
          <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} />
          <line x1={x + 4} y1={y - 4} x2={x - 4} y2={y + 4} />
        </>
      )}
    </g>
  );
}

function MovementBadge({
  movement,
  x,
  y,
}: {
  movement: number;
  x: number;
  y: number;
}) {
  const label = movement > 0 ? `+${movement}` : `${movement}`;
  let tone: 'positive' | 'negative' | 'neutral' = 'neutral';
  let scoreToneClass = '';
  if (movement > 0) {
    tone = 'positive';
    scoreToneClass = 'tool-score-tone--high';
  } else if (movement < 0) {
    tone = 'negative';
    scoreToneClass = 'tool-score-tone--low';
  }
  const width = Math.max(28, label.length * 7 + 12);
  return (
    <g
      className={[
        'bump-chart-movement-badge',
        `bump-chart-movement-badge--${tone}`,
        scoreToneClass,
      ]
        .filter(Boolean)
        .join(' ')}
      transform={`translate(${x} ${y})`}
      data-badge-label={label}
      data-badge-width={width}
      data-badge-x={x}
      data-badge-y={y}
      data-png-exclude="true"
      aria-hidden="true"
    >
      <rect x={-width / 2} y="-10" width={width} height="20" rx="10" />
      <text textAnchor="middle" dominantBaseline="central">
        {label}
      </text>
    </g>
  );
}

function cubicCoordinate(
  start: number,
  firstControl: number,
  secondControl: number,
  end: number,
  t: number,
): number {
  const remaining = 1 - t;
  return (
    remaining ** 3 * start +
    3 * remaining ** 2 * t * firstControl +
    3 * remaining * t ** 2 * secondControl +
    t ** 3 * end
  );
}

const INFERRED_MARKER_PREFERRED_POSITION = 0.95;
const INFERRED_MARKER_MIN_NODE_SEPARATION = 38;

export function inferredMatchMarkerPosition(
  width: number,
  leftY: number,
  rightY: number,
): { x: number; y: number; pathPosition: number; nodeSeparation: number } {
  const control = width * 0.42;
  const pointAt = (pathPosition: number): { x: number; y: number } => ({
    x: cubicCoordinate(
      0,
      control,
      width - control,
      width,
      pathPosition,
    ),
    y: cubicCoordinate(leftY, leftY, rightY, rightY, pathPosition),
  });
  const rightNode = { x: width, y: rightY };
  const separationAt = (pathPosition: number): number => {
    const point = pointAt(pathPosition);
    return Math.hypot(point.x - rightNode.x, point.y - rightNode.y);
  };

  let pathPosition = INFERRED_MARKER_PREFERRED_POSITION;
  if (
    separationAt(pathPosition) < INFERRED_MARKER_MIN_NODE_SEPARATION
  ) {
    let farther = 0;
    let nearer = pathPosition;
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const candidate = (farther + nearer) / 2;
      if (
        separationAt(candidate) >= INFERRED_MARKER_MIN_NODE_SEPARATION
      ) {
        farther = candidate;
      } else {
        nearer = candidate;
      }
    }
    pathPosition = farther;
  }

  const point = pointAt(pathPosition);
  return {
    ...point,
    pathPosition,
    nodeSeparation: separationAt(pathPosition),
  };
}

function InferredMatchMarker({
  connection,
  startX,
  endX,
  leftY,
  rightY,
}: {
  connection: BumpConnection;
  startX: number;
  endX: number;
  leftY: number;
  rightY: number;
}) {
  const width = endX - startX;
  const { x: localX, y, pathPosition, nodeSeparation } =
    inferredMatchMarkerPosition(width, leftY, rightY);
  const x = startX + localX;
  const description =
    connection.matchBasis === 'alternate-title'
      ? 'Inferred match from an AniList title variant'
      : 'Inferred match from a normalized label';
  return (
    <g
      className="bump-chart-inferred-marker"
      role="img"
      aria-label={description}
      tabIndex={0}
      data-marker-x={x}
      data-marker-y={y}
      data-path-position={pathPosition}
      data-preferred-path-position={INFERRED_MARKER_PREFERRED_POSITION}
      data-node-separation={nodeSeparation}
    >
      <title>{description}</title>
      <circle
        className="bump-chart-inferred-marker-backdrop"
        cx={x}
        cy={y}
        r="9"
      />
      <g
        className="bump-chart-inferred-icon"
        transform={`translate(${x - 9} ${y - 9}) scale(0.75)`}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </g>
    </g>
  );
}

function BumpChartLabel({
  side,
  item,
  rank,
  lineageKey,
  focusedKey,
  panelProps,
  onFocus,
  onEdit,
}: {
  side: ChartSide;
  item: Item;
  rank: number;
  lineageKey: string | undefined;
  focusedKey: string | null;
  panelProps: ToolPanelProps;
  onFocus: (key: string | null) => void;
  onEdit: () => void;
}) {
  const dimmed = focusedKey != null && lineageKey !== focusedKey;
  const rankButton = (
    <button
      type="button"
      className="bump-chart-rank"
      onClick={onEdit}
      title={`Edit #${rank} ${item.label}`}
      aria-label={`Edit rank ${rank}: ${item.label}`}
    >
      #{rank}
    </button>
  );
  return (
    <div
      className={[
        'bump-chart-label-cell',
        `bump-chart-label-cell--${side}`,
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseEnter={() => onFocus(lineageKey ?? null)}
      onMouseLeave={() => onFocus(null)}
    >
      {side === 'right' && rankButton}
      <InteractiveItemLabel
        item={item}
        side={side}
        panelProps={panelProps}
      />
      {side === 'left' && rankButton}
    </div>
  );
}

function TimelineOccurrenceCell({
  item,
  rank,
  columnIndex,
  itemIndex,
  lineageKey,
  color,
  focusedKey,
  isEntry,
  isDeparture,
  panelProps,
  onFocus,
  onEdit,
}: {
  item: Item;
  rank: number;
  columnIndex: number;
  itemIndex: number;
  lineageKey: string;
  color: string;
  focusedKey: string | null;
  isEntry: boolean;
  isDeparture: boolean;
  panelProps: ToolPanelProps;
  onFocus: (key: string | null) => void;
  onEdit: () => void;
}) {
  const dimmed = focusedKey != null && focusedKey !== lineageKey;
  const event = isEntry || isDeparture;
  const style = {
    color,
    '--bump-lineage-color': color,
  } as CSSProperties;
  if (!event) {
    return (
      <div
        className={`bump-chart-timeline-cell${dimmed ? ' is-dimmed' : ''}`}
        style={style}
        onClick={(event) => event.stopPropagation()}
        onMouseEnter={() => onFocus(lineageKey)}
        onMouseLeave={() => onFocus(null)}
      >
        <AnilistMiddleClickLink
          url={item.url ?? null}
          className="bump-chart-compact-node"
          aria-label={`Edit rank ${rank}: ${item.label}`}
          data-bump-lineage={lineageKey}
          data-label={item.label}
          role="button"
          tabIndex={0}
          onPrimaryClick={onEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onEdit();
            }
          }}
        >
          #{rank}
        </AnilistMiddleClickLink>
      </div>
    );
  }
  return (
    <div
      className={[
        'bump-chart-timeline-cell',
        'bump-chart-event-label',
        dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-bump-event="true"
      data-column-index={columnIndex}
      data-item-index={itemIndex}
      data-bump-lineage={lineageKey}
      style={style}
      onMouseEnter={() => onFocus(lineageKey)}
      onMouseLeave={() => onFocus(null)}
    >
      <div
        className="bump-chart-event-node"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="bump-chart-rank"
          onClick={onEdit}
          title={`Edit #${rank} ${item.label}`}
          aria-label={`Edit rank ${rank}: ${item.label}`}
        >
          #{rank}
        </button>
        <InteractiveItemLabel
          item={item}
          side="right"
          panelProps={panelProps}
        />
      </div>
    </div>
  );
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth =
    image instanceof HTMLImageElement
      ? image.naturalWidth
      : typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
        ? image.width
        : width;
  const sourceHeight =
    image instanceof HTMLImageElement
      ? image.naturalHeight
      : typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
        ? image.height
        : height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  context.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    x,
    y,
    width,
    height,
  );
}

function canvasFont(style: CSSStyleDeclaration): string {
  return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

function drawElementText(
  context: CanvasRenderingContext2D,
  element: HTMLElement,
  rootRect: DOMRect,
): void {
  const text = element.textContent ?? '';
  if (!text) return;
  const style = getComputedStyle(element);
  context.fillStyle = style.color;
  context.font = canvasFont(style);
  context.textBaseline = 'top';

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && current.data.length > 0) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }
  if (textNodes.length === 0) {
    const rect = element.getBoundingClientRect();
    context.fillText(text, rect.left - rootRect.left, rect.top - rootRect.top);
    return;
  }

  const lines = new Map<number, { text: string; left: number; top: number }>();
  for (const textNode of textNodes) {
    for (let index = 0; index < textNode.data.length; index += 1) {
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = range.getBoundingClientRect();
      const key = Math.round(rect.top * 2) / 2;
      const line = lines.get(key);
      if (line) {
        line.text += textNode.data[index];
      } else {
        lines.set(key, {
          text: textNode.data[index]!,
          left: rect.left,
          top: rect.top,
        });
      }
    }
  }
  for (const line of lines.values()) {
    context.fillText(
      line.text,
      line.left - rootRect.left,
      line.top - rootRect.top,
    );
  }
}

function chartLabelOpacity(element: Element): number {
  const cell = element.closest<HTMLElement>(
    '.bump-chart-label-cell, .bump-chart-timeline-cell',
  );
  const cellOpacity = Number.parseFloat(
    cell ? getComputedStyle(cell).opacity : '1',
  );
  const elementOpacity =
    cell === element
      ? 1
      : Number.parseFloat(getComputedStyle(element).opacity);
  const eventNode = element.closest<HTMLElement>('.bump-chart-event-node');
  const eventNodeOpacity =
    eventNode == null || eventNode === element
      ? 1
      : Number.parseFloat(getComputedStyle(eventNode).opacity);
  return (
    (Number.isFinite(cellOpacity) ? cellOpacity : 1) *
    (Number.isFinite(eventNodeOpacity) ? eventNodeOpacity : 1) *
    (Number.isFinite(elementOpacity) ? elementOpacity : 1)
  );
}

type ExportChartPngOptions = {
  includeImages?: boolean;
  itemsById?: ReadonlyMap<string, Item>;
  useMalImages?: boolean;
  onImageProgress?: (completed: number, total: number) => void;
};

async function resolveExportImages(
  imageElements: readonly HTMLImageElement[],
  options: ExportChartPngOptions,
): Promise<Array<LoadedCanvasImage | null>> {
  let completed = 0;
  const total = imageElements.length;
  options.onImageProgress?.(completed, total);
  return Promise.all(
    imageElements.map(async (image) => {
      const src = image.currentSrc || image.src;
      let loaded: LoadedCanvasImage | null = null;
      if (isAnilistCdnImageUrl(src)) {
        const itemId =
          image.closest<HTMLElement>('[data-bump-item-id]')?.dataset.bumpItemId;
        const item = itemId ? options.itemsById?.get(itemId) : undefined;
        if (options.useMalImages && item) {
          const fallback = await resolveBumpMalExportImage(item);
          if (fallback) {
            loaded = await loadCachedCanvasImage(
              fallback.url,
              fallback.cacheKey,
              {
                refreshStaleSource: () =>
                  resolveBumpMalExportImage(item, { forceRefresh: true }),
              },
            );
          }
        }
      } else {
        loaded = await loadCachedCanvasImage(src);
      }
      completed += 1;
      options.onImageProgress?.(completed, total);
      return loaded;
    }),
  );
}

function prepareExportImageLayout(
  node: HTMLElement,
  imageElements: readonly HTMLImageElement[],
  loadedImages: readonly (LoadedCanvasImage | null)[],
): () => void {
  const rows = Array.from(
    node.querySelectorAll<HTMLElement>('.bump-chart-row'),
  );
  const rowStyles = rows.map((row) => ({
    row,
    height: row.style.height,
    minHeight: row.style.minHeight,
    maxHeight: row.style.maxHeight,
  }));
  for (const { row } of rowStyles) {
    const height = `${row.getBoundingClientRect().height}px`;
    row.style.height = height;
    row.style.minHeight = height;
    row.style.maxHeight = height;
  }

  const imageStyles = imageElements.map((image) => ({
    image,
    display: image.style.display,
  }));
  imageElements.forEach((image, index) => {
    if (!loadedImages[index]) {
      image.style.display = 'none';
    }
  });

  return () => {
    for (const { row, height, minHeight, maxHeight } of rowStyles) {
      row.style.height = height;
      row.style.minHeight = minHeight;
      row.style.maxHeight = maxHeight;
    }
    for (const { image, display } of imageStyles) {
      image.style.display = display;
    }
  };
}

export function bumpChartExportCanvasLayout(node: HTMLElement): {
  width: number;
  height: number;
  scale: number;
  canvasWidth: number;
  canvasHeight: number;
} {
  const rootRect = node.getBoundingClientRect();
  const width = Math.ceil(Math.max(rootRect.width, node.scrollWidth));
  const height = Math.ceil(Math.max(rootRect.height, node.scrollHeight));
  const maxCanvasSide = 32_767;
  const maxCanvasPixels = 100_000_000;
  const scale = Math.min(
    2,
    maxCanvasSide / Math.max(width, height),
    Math.sqrt(maxCanvasPixels / Math.max(1, width * height)),
  );
  if (!Number.isFinite(scale) || scale < 0.1) {
    throw new Error(
      'The complete timeline is too large to export as one usable PNG.',
    );
  }
  return {
    width,
    height,
    scale,
    canvasWidth: Math.max(1, Math.floor(width * scale)),
    canvasHeight: Math.max(1, Math.floor(height * scale)),
  };
}

async function renderChartPng(
  node: HTMLElement,
  imageElements: readonly HTMLImageElement[],
  loadedImages: readonly (LoadedCanvasImage | null)[],
): Promise<void> {
  const rootRect = node.getBoundingClientRect();
  const { width, height, scale, canvasWidth, canvasHeight } =
    bumpChartExportCanvasLayout(node);
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas export is unavailable.');
  }
  context.scale(scale, scale);

  const rootStyle = getComputedStyle(node);
  const backgroundColor =
    rootStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      ? getComputedStyle(document.body).backgroundColor
      : rootStyle.backgroundColor;
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, width, height);

  const orderNameRow = node.querySelector<HTMLElement>(
    '.bump-chart-order-name-row',
  );
  if (orderNameRow) {
    const rowRect = orderNameRow.getBoundingClientRect();
    const rowStyle = getComputedStyle(orderNameRow);
    context.fillStyle = rowStyle.backgroundColor;
    context.fillRect(
      0,
      rowRect.top - rootRect.top,
      width,
      rowRect.height,
    );
    const borderBottomWidth = Number.parseFloat(rowStyle.borderBottomWidth);
    if (borderBottomWidth > 0) {
      context.strokeStyle = rowStyle.borderBottomColor;
      context.lineWidth = borderBottomWidth;
      context.beginPath();
      const borderY =
        rowRect.bottom - rootRect.top - borderBottomWidth / 2;
      context.moveTo(0, borderY);
      context.lineTo(width, borderY);
      context.stroke();
    }
  }

  for (const row of node.querySelectorAll<HTMLElement>('.bump-chart-row')) {
    const rowRect = row.getBoundingClientRect();
    for (const center of row.querySelectorAll<HTMLElement>(
      '.bump-chart-center-cell',
    )) {
      const centerRect = center.getBoundingClientRect();
      context.fillStyle = getComputedStyle(center).backgroundColor;
      context.fillRect(
        centerRect.left - rootRect.left,
        rowRect.top - rootRect.top,
        centerRect.width,
        rowRect.height,
      );
    }
    const rowStyle = getComputedStyle(row);
    const borderBottomWidth = Number.parseFloat(rowStyle.borderBottomWidth);
    if (!(borderBottomWidth > 0)) continue;
    context.strokeStyle = rowStyle.borderBottomColor;
    context.lineWidth = borderBottomWidth;
    context.beginPath();
    const borderY =
      rowRect.bottom - rootRect.top - borderBottomWidth / 2;
    context.moveTo(0, borderY);
    context.lineTo(width, borderY);
    context.stroke();
  }

  const svg = node.querySelector<SVGSVGElement>('.bump-chart-svg');
  if (svg) {
    const svgRect = svg.getBoundingClientRect();
    const offsetX = svgRect.left - rootRect.left;
    const offsetY = svgRect.top - rootRect.top;
    context.save();
    context.translate(offsetX, offsetY);
    for (const guide of svg.querySelectorAll<SVGLineElement>(
      '.bump-chart-guide',
    )) {
      context.strokeStyle = getComputedStyle(guide).stroke;
      context.globalAlpha = 0.45;
      context.lineWidth = 1;
      context.setLineDash([3, 5]);
      context.beginPath();
      context.moveTo(
        guide.x1.baseVal.value,
        guide.y1.baseVal.value,
      );
      context.lineTo(
        guide.x2.baseVal.value,
        guide.y2.baseVal.value,
      );
      context.stroke();
    }
    context.globalAlpha = 1;
    context.setLineDash([]);
    for (const bridge of svg.querySelectorAll<SVGPathElement>(
      '.bump-chart-lineage-bridge',
    )) {
      const pathData = bridge.getAttribute('d');
      if (!pathData) continue;
      const style = getComputedStyle(bridge);
      context.save();
      context.strokeStyle = style.stroke || style.color;
      context.globalAlpha = Number(style.opacity) || 1;
      context.lineWidth = 3;
      context.lineCap = 'round';
      context.setLineDash([5, 7]);
      context.stroke(new Path2D(pathData));
      context.restore();
    }
    for (const group of svg.querySelectorAll<SVGGElement>(
      '.bump-chart-connection',
    )) {
      const groupStyle = getComputedStyle(group);
      const groupOpacity = Number(groupStyle.opacity);
      const active = group.classList.contains('is-active');
      const color = groupStyle.color;
      context.save();
      context.globalAlpha = Number.isFinite(groupOpacity) ? groupOpacity : 1;
      const path = group.querySelector<SVGPathElement>('.bump-chart-path');
      const pathData = path?.getAttribute('d');
      if (pathData) {
        context.strokeStyle = color;
        context.lineWidth = active ? 5 : 3;
        context.lineCap = 'round';
        context.stroke(new Path2D(pathData));
      }
      for (const circle of group.querySelectorAll<SVGCircleElement>(
        '.bump-chart-node, .bump-chart-change-marker circle',
      )) {
        const isNode = circle.matches('.bump-chart-node');
        context.fillStyle = backgroundColor;
        context.strokeStyle = color;
        context.lineWidth = isNode ? (active ? 4 : 3) : 2.5;
        context.beginPath();
        context.arc(
          circle.cx.baseVal.value,
          circle.cy.baseVal.value,
          isNode && active ? 8 : circle.r.baseVal.value,
          0,
          Math.PI * 2,
        );
        context.fill();
        context.stroke();
      }
      for (const line of group.querySelectorAll<SVGLineElement>(
        '.bump-chart-change-marker line',
      )) {
        context.strokeStyle = color;
        context.lineWidth = 2.5;
        context.lineCap = 'round';
        context.beginPath();
        context.moveTo(line.x1.baseVal.value, line.y1.baseVal.value);
        context.lineTo(line.x2.baseVal.value, line.y2.baseVal.value);
        context.stroke();
      }
      const inferredMarker = group.querySelector<SVGGElement>(
        '.bump-chart-inferred-marker',
      );
      const markerX = Number(inferredMarker?.dataset.markerX);
      const markerY = Number(inferredMarker?.dataset.markerY);
      if (Number.isFinite(markerX) && Number.isFinite(markerY)) {
        context.fillStyle = backgroundColor;
        context.beginPath();
        context.arc(markerX, markerY, 9, 0, Math.PI * 2);
        context.fill();

        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.lineCap = 'round';
        context.beginPath();
        context.arc(markerX, markerY, 7.5, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.moveTo(markerX, markerY);
        context.lineTo(markerX, markerY + 3);
        context.stroke();
        context.beginPath();
        context.moveTo(markerX, markerY - 3);
        context.lineTo(markerX + 0.01, markerY - 3);
        context.stroke();
      }
      context.restore();
    }
    for (const movementBadge of svg.querySelectorAll<SVGGElement>(
      '.bump-chart-movement-badge',
    )) {
      const badgeRect =
        movementBadge.querySelector<SVGRectElement>('rect');
      const badgeText =
        movementBadge.querySelector<SVGTextElement>('text');
      const badgeX = Number(movementBadge.dataset.badgeX);
      const badgeY = Number(movementBadge.dataset.badgeY);
      const badgeWidth = Number(movementBadge.dataset.badgeWidth);
      const badgeLabel = movementBadge.dataset.badgeLabel;
      if (
        !badgeRect ||
        !badgeText ||
        !badgeLabel ||
        !Number.isFinite(badgeX) ||
        !Number.isFinite(badgeY) ||
        !Number.isFinite(badgeWidth)
      ) {
        continue;
      }
      const badgeStyle = getComputedStyle(movementBadge);
      const rectStyle = getComputedStyle(badgeRect);
      const textStyle = getComputedStyle(badgeText);
      context.save();
      context.fillStyle = rectStyle.fill || backgroundColor;
      context.strokeStyle = rectStyle.stroke || badgeStyle.color;
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(badgeX - badgeWidth / 2, badgeY - 10, badgeWidth, 20, 10);
      context.fill();
      context.stroke();
      context.fillStyle = textStyle.fill || badgeStyle.color;
      context.font = `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(badgeLabel, badgeX, badgeY);
      context.restore();
    }
    context.restore();
  }

  for (const eventNode of node.querySelectorAll<HTMLElement>(
    '.bump-chart-event-node',
  )) {
    const rect = eventNode.getBoundingClientRect();
    const style = getComputedStyle(eventNode);
    context.save();
    context.globalAlpha = chartLabelOpacity(eventNode);
    context.fillStyle = style.backgroundColor;
    context.strokeStyle = style.borderColor;
    context.lineWidth = Number.parseFloat(style.borderWidth) || 2;
    context.beginPath();
    context.roundRect(
      rect.left - rootRect.left,
      rect.top - rootRect.top,
      rect.width,
      rect.height,
      9,
    );
    context.fill();
    context.stroke();
    context.restore();
  }

  imageElements.forEach((image, index) => {
    const loaded = loadedImages[index];
    if (!loaded) return;
    const imageRect = image.getBoundingClientRect();
    context.save();
    context.globalAlpha = chartLabelOpacity(image);
    drawCoverImage(
      context,
      loaded.source,
      imageRect.left - rootRect.left,
      imageRect.top - rootRect.top,
      imageRect.width,
      imageRect.height,
    );
    context.restore();
  });

  for (const orderName of node.querySelectorAll<HTMLElement>(
    '.bump-chart-order-name',
  )) {
    drawElementText(context, orderName, rootRect);
  }
  for (const label of node.querySelectorAll<HTMLElement>(
    '.bump-chart-label',
  )) {
    context.save();
    context.globalAlpha = chartLabelOpacity(label);
    drawElementText(context, label, rootRect);
    context.restore();
  }
  for (const rank of node.querySelectorAll<HTMLElement>('.bump-chart-rank')) {
    context.save();
    context.globalAlpha = chartLabelOpacity(rank);
    drawElementText(context, rank, rootRect);
    context.restore();
  }
  for (const marker of node.querySelectorAll<HTMLElement>(
    '.bump-chart-compact-node',
  )) {
    const rect = marker.getBoundingClientRect();
    const style = getComputedStyle(marker);
    context.save();
    context.globalAlpha = chartLabelOpacity(marker);
    if (marker.matches('.bump-chart-compact-node')) {
      context.fillStyle = style.backgroundColor;
      context.strokeStyle = style.borderColor;
      context.lineWidth = Number.parseFloat(style.borderWidth) || 2;
      context.beginPath();
      context.roundRect(
        rect.left - rootRect.left,
        rect.top - rootRect.top,
        rect.width,
        rect.height,
        9,
      );
      context.fill();
      context.stroke();
    }
    drawElementText(context, marker, rootRect);
    context.restore();
  }

  context.strokeStyle = rootStyle.borderColor;
  context.lineWidth = 1;
  context.strokeRect(0.5, 0.5, width - 1, height - 1);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('PNG encoding failed.')),
      'image/png',
    );
  });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = 'bump-chart.png';
  link.click();
  URL.revokeObjectURL(downloadUrl);
}

export async function exportChartPng(
  node: HTMLElement,
  options: ExportChartPngOptions = {},
): Promise<void> {
  const imageElements = Array.from(
    node.querySelectorAll<HTMLImageElement>('.bump-chart-item-link img'),
  );
  const loadedImages =
    options.includeImages === false
      ? imageElements.map(() => null)
      : await resolveExportImages(imageElements, options);
  const restoreExportLayout = prepareExportImageLayout(
    node,
    imageElements,
    loadedImages,
  );
  try {
    await renderChartPng(node, imageElements, loadedImages);
  } finally {
    restoreExportLayout();
    loadedImages.forEach((loaded) => loaded?.dispose());
  }
}

type RenderedTimelineColumn = {
  id: string;
  kind: 'previous' | 'current';
  name: string;
  items: readonly BumpChartItem[];
  matchingItems: readonly BumpChartItem[];
};

function BumpChart({
  columns,
  bestMatchByTitle,
  panelProps,
  onEdit,
  chartRef,
}: {
  columns: readonly RenderedTimelineColumn[];
  bestMatchByTitle: boolean;
  panelProps: ToolPanelProps;
  onEdit: (columnId: string, index: number, item: Item) => void;
  chartRef: React.RefObject<HTMLDivElement>;
}) {
  const timeline = useMemo(
    () =>
      buildBumpTimeline(
        columns.map((column) => ({
          id: column.id,
          items: column.matchingItems,
        })),
        { bestMatchByTitle },
      ),
    [bestMatchByTitle, columns],
  );
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [layout, setLayout] = useState<ChartLayout | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const rowCount = Math.max(0, ...columns.map(({ items }) => items.length));
  const focusedKey = pinnedKey ?? hoveredKey;
  const focusedSegments =
    focusedKey == null
      ? []
      : timeline.segments.filter(
          ({ kind, lineageKey }) =>
            kind === 'matched' && lineageKey === focusedKey,
        );
  const gridTemplateColumns = columns
    .flatMap((_, columnIndex) => [
      ...(columnIndex > 0 ? ['minmax(280px, 1fr)'] : []),
      columnIndex === 0 || columnIndex === columns.length - 1
        ? 'var(--bump-label-width)'
        : 'var(--bump-intermediate-width)',
    ])
    .map((value) =>
      value === 'minmax(280px, 1fr)'
        ? 'minmax(var(--bump-center-min-width), 1fr)'
        : value,
    )
    .join(' ');
  const minimumWidth = `calc(${[
    'var(--bump-label-width)',
    'var(--bump-label-width)',
    ...Array.from(
      { length: Math.max(0, columns.length - 1) },
      () => 'var(--bump-center-min-width)',
    ),
    ...Array.from(
      { length: Math.max(0, columns.length - 2) },
      () => 'var(--bump-intermediate-width)',
    ),
  ].join(' + ')})`;

  const lineageAt = useCallback(
    (columnIndex: number, itemIndex: number) =>
      timeline.lineageByOccurrence.get(`${columnIndex}:${itemIndex}`),
    [timeline],
  );

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || !chartRef.current?.contains(target)) {
        return;
      }
      const lineageElement =
        target.closest<HTMLElement>('[data-bump-lineage]');
      setPinnedKey(lineageElement?.dataset.bumpLineage ?? null);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [chartRef]);

  useEffect(() => {
    if (
      pinnedKey != null &&
      !timeline.lineages.some(({ key }) => key === pinnedKey)
    ) {
      setPinnedKey(null);
    }
  }, [pinnedKey, timeline.lineages]);

  useLayoutEffect(() => {
    const root = chartRef.current;
    if (!root || rowCount === 0) return;
    const measure = (): void => {
      const rootRect = root.getBoundingClientRect();
      const rows = rowRefs.current.slice(0, rowCount);
      const rowRects = rows.map((row) => {
        const rect = row?.getBoundingClientRect();
        return {
          top: rect?.top ?? rootRect.top,
          height: rect?.height ?? 0,
        };
      });
      const centers = bumpRowCenterOffsets(rootRect.top, rowRects);
      const firstRow = rows[0];
      if (!firstRow) return;
      const columnXs = columns.map((_, columnIndex) => {
        const cell = firstRow.querySelector<HTMLElement>(
          `[data-bump-column-cell="${columnIndex}"]`,
        );
        const rect = cell?.getBoundingClientRect();
        if (!rect) return 0;
        return bumpTimelineColumnAnchorX(
          columnIndex,
          columns.length,
          rootRect.left,
          rect,
        );
      });
      const centersByColumn = columns.map(({ items }) =>
        items.map((_, itemIndex) => centers[itemIndex] ?? 0),
      );
      const eventBoundsByColumn = columns.map(({ items }, columnIndex) =>
        items.map((_, itemIndex) => {
          const event = root.querySelector<HTMLElement>(
            `[data-bump-event][data-column-index="${columnIndex}"][data-item-index="${itemIndex}"]`,
          );
          if (!event) return null;
          const rect = event.getBoundingClientRect();
          return {
            left: rect.left - rootRect.left,
            right: rect.right - rootRect.left,
          };
        }),
      );
      const next: ChartLayout = {
        width: rootRect.width,
        // Avoid an earlier absolute SVG height keeping scrollHeight enlarged.
        height: rootRect.height,
        columnXs,
        centersByColumn,
        eventBoundsByColumn,
      };
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    rowRefs.current.slice(0, rowCount).forEach((row) => {
      if (row) observer?.observe(row);
    });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [chartRef, columns, rowCount]);

  return (
    <div className="tool-chart-fullbleed bump-chart-fullbleed bump-chart-scroll">
      <div
        className="bump-chart-grid bump-chart-grid--timeline"
        ref={chartRef}
        style={{ minWidth: minimumWidth }}
      >
        <div
          className="bump-chart-order-name-row"
          style={{ gridTemplateColumns }}
          aria-label="Order names"
        >
          {columns.flatMap((column, columnIndex) => {
            const nameCell = (
              <div
                key={`order-name:${column.id}`}
                className="bump-chart-order-name-cell"
                data-bump-order-id={column.id}
              >
                <span className="bump-chart-order-name">{column.name}</span>
              </div>
            );
            return columnIndex === 0
              ? [nameCell]
              : [
                  <div
                    key={`order-name-corridor:${column.id}`}
                    className="bump-chart-order-name-corridor"
                    aria-hidden="true"
                  />,
                  nameCell,
                ];
          })}
        </div>
        {Array.from({ length: rowCount }, (_, rowIndex) => (
          <div
            key={`row:${rowIndex}`}
            ref={(element) => {
              rowRefs.current[rowIndex] = element;
            }}
            className="bump-chart-row"
            style={{ gridTemplateColumns }}
          >
            {columns.flatMap((column, columnIndex) => {
              const entry = column.items[rowIndex];
              const lineage = lineageAt(columnIndex, rowIndex);
              const columnCell = (
                <div
                  key={`column:${column.id}`}
                  className={[
                    columnIndex === 0 || columnIndex === columns.length - 1
                      ? 'bump-chart-endpoint-cell'
                      : 'bump-chart-intermediate-cell',
                    !entry ? 'bump-chart-label-cell--empty' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-bump-column-cell={columnIndex}
                >
                  {entry &&
                    (columnIndex === 0 ||
                    columnIndex === columns.length - 1 ? (
                      <BumpChartLabel
                        side={columnIndex === 0 ? 'left' : 'right'}
                        item={entry.item}
                        rank={rowIndex + 1}
                        lineageKey={lineage?.key}
                        focusedKey={focusedKey}
                        panelProps={panelProps}
                        onFocus={setHoveredKey}
                        onEdit={() =>
                          onEdit(column.id, rowIndex, entry.item)
                        }
                      />
                    ) : lineage ? (
                      <TimelineOccurrenceCell
                        item={entry.item}
                        rank={rowIndex + 1}
                        columnIndex={columnIndex}
                        itemIndex={rowIndex}
                        lineageKey={lineage.key}
                        color={BUMP_CHART_COLORS[lineage.colorIndex]!}
                        focusedKey={focusedKey}
                        isEntry={
                          lineage.itemIndexes[columnIndex - 1] == null
                        }
                        isDeparture={
                          lineage.itemIndexes[columnIndex + 1] == null
                        }
                        panelProps={panelProps}
                        onFocus={setHoveredKey}
                        onEdit={() =>
                          onEdit(column.id, rowIndex, entry.item)
                        }
                      />
                    ) : null)}
                </div>
              );
              return columnIndex === 0
                ? [columnCell]
                : [
                    <div
                      key={`corridor:${columnIndex}`}
                      className="bump-chart-center-cell"
                      aria-hidden="true"
                    />,
                    columnCell,
                  ];
            })}
          </div>
        ))}
        {layout && (
          <svg
            className="bump-chart-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="none"
            aria-label="Rank movement timeline"
            style={{ width: layout.width, height: layout.height }}
          >
            {Array.from({ length: rowCount }, (_, index) => (
              <line
                key={`guide:${index}`}
                className="bump-chart-guide"
                x1={layout.columnXs[0] ?? 0}
                y1={
                  layout.centersByColumn.find(
                    (centers) => centers[index] != null,
                  )?.[index] ?? 0
                }
                x2={layout.columnXs[layout.columnXs.length - 1] ?? layout.width}
                y2={
                  layout.centersByColumn.find(
                    (centers) => centers[index] != null,
                  )?.[index] ?? 0
                }
              />
            ))}
            {pinnedKey &&
              timeline.lineages
                .find(({ key }) => key === pinnedKey)
                ?.gaps.map((gap) => {
                  const fromY =
                    layout.centersByColumn[gap.fromColumnIndex]?.[
                      gap.fromItemIndex
                    ] ?? 0;
                  const toY =
                    layout.centersByColumn[gap.toColumnIndex]?.[
                      gap.toItemIndex
                    ] ?? 0;
                  const fromBounds = eventBounds(
                    layout,
                    gap.fromColumnIndex,
                    gap.fromItemIndex,
                  );
                  const toBounds = eventBounds(
                    layout,
                    gap.toColumnIndex,
                    gap.toItemIndex,
                  );
                  return (
                    <path
                      key={`gap:${pinnedKey}:${gap.fromColumnIndex}`}
                      className="bump-chart-lineage-bridge"
                      d={`M ${
                        fromBounds
                          ? fromBounds.right + 45
                          : (layout.columnXs[gap.fromColumnIndex] ?? 0) + 55
                      } ${fromY} L ${
                        toBounds
                          ? toBounds.left - 45
                          : (layout.columnXs[gap.toColumnIndex] ?? 0) - 55
                      } ${toY}`}
                      style={{
                        color:
                          BUMP_CHART_COLORS[
                            timeline.lineages.find(
                              ({ key }) => key === pinnedKey,
                            )?.colorIndex ?? 0
                          ],
                      }}
                    />
                  );
                })}
            {timeline.segments.map((connection) => {
              const path = timelineMovementPath(connection, layout);
              const color = BUMP_CHART_COLORS[connection.colorIndex]!;
              const dimmed =
                focusedKey != null && focusedKey !== connection.lineageKey;
              const active = focusedKey === connection.lineageKey;
              const leftX = layout.columnXs[connection.pairIndex] ?? 0;
              const rightX =
                layout.columnXs[connection.pairIndex + 1] ?? 0;
              const leftY =
                connection.leftIndex == null
                  ? null
                  : layout.centersByColumn[connection.pairIndex]?.[
                      connection.leftIndex
                    ];
              const rightY =
                connection.rightIndex == null
                  ? null
                  : layout.centersByColumn[connection.pairIndex + 1]?.[
                      connection.rightIndex
                    ];
              return (
                <g
                  key={connection.key}
                  className={[
                    'bump-chart-connection',
                    dimmed ? 'is-dimmed' : '',
                    active ? 'is-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-bump-lineage={connection.lineageKey}
                  style={{ color }}
                  onMouseEnter={() => setHoveredKey(connection.lineageKey)}
                  onMouseLeave={() => setHoveredKey(null)}
                >
                  <path
                    className="bump-chart-path-hit"
                    d={path}
                    data-bump-lineage={connection.lineageKey}
                  />
                  <path
                    className="bump-chart-path"
                    d={path}
                    data-bump-lineage={connection.lineageKey}
                  />
                  {leftY != null && connection.pairIndex === 0 && (
                    <circle
                      className="bump-chart-node"
                      cx={leftX}
                      cy={leftY}
                      r="6"
                      data-bump-lineage={connection.lineageKey}
                    />
                  )}
                  {rightY != null &&
                    connection.pairIndex + 1 === columns.length - 1 && (
                    <circle
                      className="bump-chart-node"
                      cx={rightX}
                      cy={rightY}
                      r="6"
                      data-bump-lineage={connection.lineageKey}
                    />
                  )}
                  {connection.kind === 'removed' && leftY != null && (
                    <ChangeMarker
                      kind="removed"
                      x={changeMarkerX(connection, layout)}
                      y={leftY}
                    />
                  )}
                  {connection.kind === 'added' && rightY != null && (
                    <ChangeMarker
                      kind="added"
                      x={changeMarkerX(connection, layout)}
                      y={rightY}
                    />
                  )}
                  {connection.matchBasis !== 'logical-id' &&
                    connection.matchBasis !== 'source-id' &&
                    connection.matchBasis != null &&
                    leftY != null &&
                    rightY != null && (
                      <InferredMatchMarker
                        connection={connection}
                        startX={
                          eventBounds(
                            layout,
                            connection.pairIndex,
                            connection.leftIndex!,
                          )?.right ?? leftX
                        }
                        endX={
                          eventBounds(
                            layout,
                            connection.pairIndex + 1,
                            connection.rightIndex!,
                          )?.left ?? rightX
                        }
                        leftY={leftY}
                        rightY={rightY}
                      />
                    )}
                </g>
              );
            })}
            {focusedSegments.map((connection) => {
              const leftY =
                connection.leftIndex == null
                  ? null
                  : layout.centersByColumn[connection.pairIndex]?.[
                      connection.leftIndex
                    ];
              const rightY =
                connection.rightIndex == null
                  ? null
                  : layout.centersByColumn[connection.pairIndex + 1]?.[
                      connection.rightIndex
                    ];
              if (leftY == null || rightY == null) return null;
              const midpoint = bumpTimelinePathMidpoint(
                layout.columnXs[connection.pairIndex] ?? 0,
                layout.columnXs[connection.pairIndex + 1] ?? 0,
                eventBounds(
                  layout,
                  connection.pairIndex,
                  connection.leftIndex!,
                ),
                eventBounds(
                  layout,
                  connection.pairIndex + 1,
                  connection.rightIndex!,
                ),
                leftY,
                rightY,
              );
              return (
                <MovementBadge
                  key={`movement:${connection.key}`}
                  movement={bumpConnectionMovement(connection) ?? 0}
                  x={midpoint.x}
                  y={midpoint.y}
                />
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

function SaveBumpChartModal({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (
    name: string,
    replaceId?: string,
  ) => Promise<SaveNamedBumpChartResult>;
}) {
  const [name, setName] = useState('');
  const [replace, setReplace] = useState<SavedBumpChartMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  const commit = async (): Promise<void> => {
    setSaving(true);
    const result = await onSave(name, replace?.id);
    setSaving(false);
    if (result.status === 'exists') {
      setReplace(result.meta);
      setError(
        `A saved chart named “${result.meta.name}” already exists. Confirm to replace it.`,
      );
    } else if (result.status === 'limit') {
      setError(
        `You can save up to ${BUMP_CHART_SLOT_LIMIT} charts. Delete one before saving another.`,
      );
    } else if (result.status === 'error') {
      setError(result.error);
    }
  };

  return (
    <Modal label="Save Bump Chart" onClose={onCancel}>
      <h3>Save chart</h3>
      <label className="edit-item-field">
        <span className="edit-item-label">Chart name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setReplace(null);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name.trim()) {
              void commit();
            }
          }}
        />
      </label>
      {error && <p className="tool-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!name.trim() || saving}
          onClick={() => void commit()}
        >
          {replace ? 'Replace chart' : 'Save chart'}
        </button>
      </div>
    </Modal>
  );
}

const SAVED_BUMP_CHARTS_EXPANDED_KEY =
  'sorter:tools:bump-chart:saved-expanded:v1';

function loadSavedBumpChartsExpanded(): boolean {
  try {
    return localStorage.getItem(SAVED_BUMP_CHARTS_EXPANDED_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function saveSavedBumpChartsExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(
      SAVED_BUMP_CHARTS_EXPANDED_KEY,
      expanded ? 'expanded' : 'collapsed',
    );
  } catch {
    // Keep the in-memory preference when browser storage is unavailable.
  }
}

function SavedBumpCharts({
  slots,
  deletingId,
  onLoad,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  slots: readonly SavedBumpChartMeta[];
  deletingId: string | null;
  onLoad: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(loadSavedBumpChartsExpanded);
  if (slots.length === 0) {
    return null;
  }
  const toggleExpanded = (): void => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    saveSavedBumpChartsExpanded(nextExpanded);
  };
  return (
    <section
      className={`tool-form-card bump-chart-saved-charts${
        expanded ? '' : ' is-collapsed'
      }`}
    >
      <div className="bump-chart-saved-heading">
        <button
          type="button"
          className="bump-chart-saved-heading-toggle"
          aria-expanded={expanded}
          aria-controls="bump-chart-saved-list"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} saved charts`}
          onClick={toggleExpanded}
        >
          <span className="staged-panel-caret" aria-hidden />
          <h3>Saved charts</h3>
          <span className="bump-chart-saved-count">{slots.length} saved</span>
        </button>
      </div>
      {expanded && (
        <div className="bump-chart-saved-list" id="bump-chart-saved-list">
          {slots.map((slot) => (
            <div className="bump-chart-saved-row" key={slot.id}>
              <span className="bump-chart-saved-name">{slot.name}</span>
              <span className="bump-chart-saved-date">
                {new Date(slot.updatedAt).toLocaleString()}
              </span>
              {deletingId === slot.id ? (
                <div className="bump-chart-saved-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={onCancelDelete}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => onConfirmDelete(slot.id)}
                  >
                    Confirm delete
                  </button>
                </div>
              ) : (
                <div className="bump-chart-saved-actions">
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => onLoad(slot.id)}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => onRequestDelete(slot.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function BumpChartPanel(panelProps: ToolPanelProps) {
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const {
    prefs: toolsPreferences,
    setBumpChartBestMatchByTitle,
  } = useToolsPreferences();
  const onOpenItemDetail = useCallback(
    (item: Item) => openItemDetail(item, panelProps),
    [panelProps.onOpenMedia, panelProps.onOpenStaff],
  );
  const [columns, setColumns] =
    useState<BumpColumnDraft[]>(defaultDraftColumns);
  const [importColumnId, setImportColumnId] = useState<string | null>(null);
  const [importTab, setImportTab] = useState<AddItemsModalTab>('single');
  const [chart, setChart] = useState<GeneratedBumpChart | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [pendingImports, setPendingImports] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedCharts, setSavedCharts] = useState<SavedBumpChartMeta[]>([]);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [deletingSavedId, setDeletingSavedId] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const latestWorkspaceRef = useRef<BumpChartWorkspaceSnapshot | null>(null);
  const importTabTouchedBeforeHydration = useRef(false);
  const localWorkspaceRevisionRef = useRef(0);
  const stagingRevisionRef = useRef(0);
  const markWorkspaceMutation = useCallback((): void => {
    localWorkspaceRevisionRef.current += 1;
  }, []);
  if (
    storageHydrated ||
    localWorkspaceRevisionRef.current > 0 ||
    columns.some(({ draft }) => draft.groups.length > 0) ||
    chart !== null ||
    importTab !== 'single'
  ) {
    latestWorkspaceRef.current = workspaceFromState(
      columns,
      chart,
      toolsPreferences.bumpChartBestMatchByTitle,
      importTab,
    );
  }

  useEffect(() => {
    let cancelled = false;
    const hydrationStartRevision = localWorkspaceRevisionRef.current;
    void initializeBumpChartStorage().then(() => {
      if (cancelled) return;
      const workspace = loadActiveBumpChartWorkspace();
      const localStateIsUnchanged =
        localWorkspaceRevisionRef.current === hydrationStartRevision;
      if (workspace && localStateIsUnchanged) {
        const source =
          workspace.view === 'chart' ? 'From chart' : 'Cached chart';
        setColumns(
          workspace.columns.map((column) => ({
            id: column.id,
            kind: column.kind,
            ...(column.name ? { name: column.name } : {}),
            draft: draftFromSnapshot(column, source),
          })),
        );
        setChart(null);
        if (!importTabTouchedBeforeHydration.current) {
          setImportTab(workspace.lastImportTab);
        }
        if (
          workspace.bestMatchByTitle !==
          toolsPreferences.bumpChartBestMatchByTitle
        ) {
          setBumpChartBestMatchByTitle(workspace.bestMatchByTitle);
        }
      }
      setSavedCharts(listSavedBumpCharts());
      const status = getStateStorageStatus();
      setStorageError(
        status.persistent
          ? null
          : `Persistent storage is unavailable: ${status.error ?? 'unknown error'}. This tab is using memory-only mode.`,
      );
      setStorageHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageHydrated) return;
    const snapshot = workspaceFromState(
      columns,
      chart,
      toolsPreferences.bumpChartBestMatchByTitle,
      importTab,
    );
    latestWorkspaceRef.current = snapshot;
    const timer = window.setTimeout(() => {
      void saveActiveBumpChartWorkspace(snapshot).then((result) => {
        setStorageError(result.ok ? null : result.error);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    chart,
    columns,
    importTab,
    storageHydrated,
    toolsPreferences.bumpChartBestMatchByTitle,
  ]);

  useEffect(
    () => () => {
      if (latestWorkspaceRef.current) {
        void saveActiveBumpChartWorkspace(latestWorkspaceRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    function onStorage(event: StorageEvent): void {
      if (event.key !== STATE_REVISION_KEY || !event.newValue) return;
      let revision:
        | { scope?: string; id?: string; source?: string }
        | undefined;
      try {
        revision = JSON.parse(event.newValue) as typeof revision;
      } catch {
        return;
      }
      if (
        revision?.scope !== 'bump' ||
        revision.source === getStateWriterId()
      ) {
        return;
      }
      // An open tab owns its active draft; cross-tab revisions only refresh
      // named charts and must not replace mounted React state.
      if (revision.id === 'active') return;
      void refreshBumpChartStorage().then(() => {
        setSavedCharts(listSavedBumpCharts());
      });
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const appendGroup = useCallback(
    async (
      targetColumnId: string,
      source: string,
      incoming: BumpChartItem[],
    ): Promise<void> => {
      const stagingRevision = stagingRevisionRef.current;
      setPendingImports((count) => count + 1);
      setImportError(null);
      try {
        const hydrated = await hydrateBumpChartItems(incoming);
        if (hydrated.length === 0) {
          return;
        }
        if (stagingRevisionRef.current !== stagingRevision) {
          return;
        }
        markWorkspaceMutation();
        setColumns((current) =>
          current.map((column) =>
            column.id === targetColumnId
              ? {
                  ...column,
                  draft: {
                    ...column.draft,
                    groups: [
                      ...column.draft.groups,
                      { id: stageId(), source, items: hydrated },
                    ],
                  },
                }
              : column,
          ),
        );
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : 'Item import failed.',
        );
      } finally {
        setPendingImports((count) => Math.max(0, count - 1));
      }
    },
    [markWorkspaceMutation],
  );

  const closeImporter = (): void => setImportColumnId(null);

  const importCallbacks =
    importColumnId == null
      ? null
      : {
          onAddOne: (item: Item) => {
            void appendGroup(
              importColumnId,
              'Single item',
              bumpItemsFromImportedItems([item]),
            );
            closeImporter();
          },
          onAddMany: (items: Item[]) => {
            void appendGroup(
              importColumnId,
              'AniList selection',
              bumpItemsFromImportedItems(items),
            );
            closeImporter();
          },
          onAddPreRanked: (items: Item[]) => {
            void appendGroup(
              importColumnId,
              'Pasted / CSV list',
              bumpItemsFromImportedItems(items),
            );
            closeImporter();
          },
          onImportOrderedItems: (imports: OrderedSlotImport[]) => {
            void (async () => {
              for (const entry of imports) {
                await appendGroup(
                  importColumnId,
                  entry.source,
                  bumpItemsFromSortResults(entry.items),
                );
              }
            })();
            closeImporter();
          },
        };

  const patchDraft = (
    targetColumnId: string,
    update: (draft: BumpSideDraft) => BumpSideDraft,
  ): void => {
    markWorkspaceMutation();
    setColumns((current) =>
      current.map((column) => {
        if (column.id !== targetColumnId) return column;
        const next = update(column.draft);
        return {
          ...column,
          draft: hasCustomAnilistLabels(itemsInDraft(next))
            ? next
            : { ...next, preserveCustomLabels: false },
        };
      }),
    );
  };

  const renameColumn = (
    targetColumnId: string,
    name: string | undefined,
  ): void => {
    markWorkspaceMutation();
    setColumns((current) =>
      current.map((column) =>
        column.id === targetColumnId
          ? { ...column, name }
          : column,
      ),
    );
  };

  const toggleGroupRemoval = (targetColumnId: string, groupId: string): void => {
    patchDraft(targetColumnId, (draft) => ({
      ...draft,
      groups: draft.groups.map((group) =>
        group.id === groupId
          ? { ...group, markedForRemoval: !group.markedForRemoval }
          : group,
      ),
    }));
  };

  const toggleItemRemoval = (
    targetColumnId: string,
    groupId: string,
    index: number,
  ): void => {
    patchDraft(targetColumnId, (draft) => ({
      ...draft,
      groups: draft.groups.map((group) => {
        if (group.id !== groupId) return group;
        const itemId = group.items[index]?.item.id;
        if (!itemId) return group;
        const markedItemIds = new Set(group.markedItemIds);
        if (markedItemIds.has(itemId)) markedItemIds.delete(itemId);
        else markedItemIds.add(itemId);
        return { ...group, markedItemIds };
      }),
    }));
  };

  const draftItemsByColumn = new Map(
    columns.map((column) => [column.id, itemsInDraft(column.draft)]),
  );
  const visibleChartColumns = useMemo(
    () =>
      chart?.columns.map((column) => ({
        column,
        visible: column.items.flatMap((entry, sourceIndex) =>
          column.hiddenItemIds.has(entry.item.id)
            ? []
            : [{ entry, sourceIndex }],
        ),
      })) ?? [],
    [chart],
  );
  const renderedChartColumns = useMemo(
    () =>
      visibleChartColumns.map(({ column, visible }, index, allColumns) => ({
        id: column.id,
        kind: column.kind,
        name: column.name ?? orderFallbackLabel(index, allColumns.length),
        matchingItems: visible.map(({ entry }) => entry),
        items: displayBumpChartItems(
          visible.map(({ entry }) => entry),
          column.preserveCustomLabels,
        ),
      })),
    [displayLabelRevision, visibleChartColumns],
  );
  const currentDraftColumn = columns[columns.length - 1]!;

  const addCurrentOrder = (): void => {
    markWorkspaceMutation();
    setColumns((current) => {
      const currentColumn = current[current.length - 1]!;
      const promotedColumn: BumpColumnDraft = {
        ...currentColumn,
        id: columnId(new Set(current.map(({ id }) => id))),
        kind: 'previous',
      };
      return [
        ...current.slice(0, -1),
        promotedColumn,
        { id: 'current', kind: 'current', draft: emptyDraft() },
      ];
    });
  };

  const removePreviousOrder = (targetColumnId: string): void => {
    markWorkspaceMutation();
    setColumns((current) => {
      const previousCount = current.filter(
        ({ kind }) => kind === 'previous',
      ).length;
      return previousCount <= 1
        ? current
        : current.filter(({ id }) => id !== targetColumnId);
    });
  };

  const removeCurrentOrder = (): void => {
    markWorkspaceMutation();
    setColumns((current) => {
      if (current.length <= 2) {
        return current;
      }
      const nextCurrent = current[current.length - 2]!;
      return [
        ...current.slice(0, -2),
        { ...nextCurrent, id: 'current', kind: 'current' },
      ];
    });
  };

  const moveOrder = (
    targetColumnId: string,
    direction: -1 | 1,
  ): void => {
    markWorkspaceMutation();
    setColumns((current) => {
      const index = current.findIndex(({ id }) => id === targetColumnId);
      const targetIndex = index + direction;
      if (
        index < 0 ||
        targetIndex < 0 ||
        targetIndex >= current.length
      ) {
        return current;
      }
      const next = [...current];
      const source = next[index]!;
      const target = next[targetIndex]!;
      if (source.kind === target.kind) {
        [next[index], next[targetIndex]] = [target, source];
      } else {
        // Keep the final slot's stable `current` identity while moving the
        // staged order data and name across the previous/current boundary.
        next[index] = { ...source, name: target.name, draft: target.draft };
        next[targetIndex] = {
          ...target,
          name: source.name,
          draft: source.draft,
        };
      }
      return next;
    });
  };

  const clearStaged = (): void => {
    stagingRevisionRef.current += 1;
    markWorkspaceMutation();
    setColumns((current) =>
      current.length > 2
        ? defaultDraftColumns()
        : current.map((column) => ({ ...column, draft: emptyDraft() })),
    );
    setImportColumnId(null);
    setImportError(null);
  };

  const generateChart = (): void => {
    markWorkspaceMutation();
    setChart({
      columns: columns.map((column) => {
        const snapshot = draftToSnapshot(column.draft);
        return {
          id: column.id,
          kind: column.kind,
          ...(column.name ? { name: column.name } : {}),
          items: snapshot.items,
          hiddenItemIds: new Set(snapshot.hiddenItemIds),
          preserveCustomLabels: snapshot.preserveCustomLabels,
        };
      }),
    });
    setColumns(defaultDraftColumns());
    setImportColumnId(null);
    setImportError(null);
    setExportError(null);
  };

  const saveEdit = (payload: EditItemSavePayload): void => {
    if (!editTarget) {
      return;
    }
    const updated = applyCachedAnilistItemEdit(editTarget.item, payload);
    if (editTarget.scope === 'draft') {
      patchDraft(editTarget.columnId, (draft) => ({
        ...draft,
        groups: draft.groups.map((group) =>
          group.id === editTarget.groupId
            ? {
                ...group,
                markedItemIds: group.markedItemIds?.has(editTarget.item.id)
                  ? new Set(
                      [...group.markedItemIds].map((id) =>
                        id === editTarget.item.id ? updated.id : id,
                      ),
                    )
                  : group.markedItemIds,
                items: group.items.map((entry, index) =>
                  index === editTarget.index
                    ? applyBumpChartItemEdit(entry, payload)
                    : entry,
                ),
              }
            : group,
        ),
      }));
    } else {
      markWorkspaceMutation();
      setChart((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          columns: current.columns.map((column) =>
            column.id === editTarget.columnId
              ? {
                  ...column,
                  items: column.items.map((entry, index) =>
                    index === editTarget.index
                      ? applyBumpChartItemEdit(entry, payload)
                      : entry,
                  ),
                }
              : column,
          ),
        };
      });
    }
    setEditTarget(null);
  };

  const hideEditedChartItems = (): void => {
    if (editTarget?.scope !== 'chart') {
      return;
    }
    markWorkspaceMutation();
    setChart((current) => {
      if (!current) {
        return current;
      }
      const targetColumn = current.columns.find(
        ({ id }) => id === editTarget.columnId,
      );
      const entry = targetColumn?.items[editTarget.index];
      if (!entry) {
        return current;
      }
      return {
        ...current,
        columns: current.columns.map((column) => {
          if (column.id !== editTarget.columnId) return column;
          const hiddenItemIds = new Set(column.hiddenItemIds);
          hiddenItemIds.add(entry.item.id);
          return { ...column, hiddenItemIds };
        }),
      };
    });
    setEditTarget(null);
  };

  const clearChart = (): void => {
    if (!chart) {
      return;
    }
    markWorkspaceMutation();
    setColumns(
      chart.columns.map((column) => ({
        id: column.id,
        kind: column.kind,
        ...(column.name ? { name: column.name } : {}),
        draft: draftFromSnapshot(chartColumnToSnapshot(column), 'From chart'),
      })),
    );
    setChart(null);
    setExportError(null);
  };

  const loadNamedChart = (id: string): void => {
    const workspace = loadSavedBumpChart(id);
    if (!workspace) {
      setStorageError('The saved chart could not be loaded.');
      return;
    }
    markWorkspaceMutation();
    setColumns(defaultDraftColumns());
    setChart(chartFromSnapshot(workspace));
    setBumpChartBestMatchByTitle(workspace.bestMatchByTitle);
    setImportColumnId(null);
    setImportError(null);
    setExportError(null);
    setStorageError(null);
    setDeletingSavedId(null);
  };

  const saveCurrentChart = async (
    name: string,
    replaceId?: string,
  ): Promise<SaveNamedBumpChartResult> => {
    if (!chart) {
      return { status: 'error', error: 'There is no generated chart to save.' };
    }
    const result = await saveNamedBumpChart(
      name,
      workspaceFromState(
        columns,
        chart,
        toolsPreferences.bumpChartBestMatchByTitle,
        importTab,
      ),
      replaceId,
    );
    if (result.status === 'saved') {
      setSavedCharts(listSavedBumpCharts());
      setSaveModalOpen(false);
      setStorageError(null);
    }
    return result;
  };

  const deleteNamedChart = (id: string): void => {
    void deleteSavedBumpChart(id).then((result) => {
    if (result.ok) {
      setSavedCharts(listSavedBumpCharts());
      setDeletingSavedId(null);
      setStorageError(null);
    } else {
      setStorageError(result.error);
    }
    });
  };

  const exportPng = async (): Promise<void> => {
    if (!chartRef.current) {
      return;
    }
    setExporting(true);
    setExportProgress(null);
    setExportError(null);
    try {
      const itemsById = new Map(
        renderedChartColumns
          .flatMap(({ items }) => items)
          .map((entry) => [entry.item.id, entry.item]),
      );
      const includeImages = toolsPreferences.bumpChartIncludeExportImages;
      const useMalImages =
        includeImages && toolsPreferences.bumpChartMalExportImages;
      await exportChartPng(chartRef.current, {
        includeImages,
        itemsById,
        useMalImages,
        onImageProgress: useMalImages
          ? (completed, total) => {
              if (total > 0) {
                setExportProgress(`${completed}/${total}`);
              }
            }
          : undefined,
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'PNG export failed.',
      );
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  return (
    <section className="tool-panel bump-chart-panel">
      <p className="tool-panel-lead">
        Stage an ordered timeline of ranked lists, then generate a chart of
        items moving up, down, on, or off the ranking.
      </p>
      <p className="tool-panel-lead tool-panel-lead-secondary">
        Click an item&apos;s rank number in the generated chart to edit its
        label, URL, image, or ID, or to remove that node from the chart.
      </p>

      {!chart ? (
        <>
          <SavedBumpCharts
            slots={savedCharts}
            deletingId={deletingSavedId}
            onLoad={loadNamedChart}
            onRequestDelete={setDeletingSavedId}
            onCancelDelete={() => setDeletingSavedId(null)}
            onConfirmDelete={deleteNamedChart}
          />
          <div className="bump-chart-import-grid bump-chart-import-grid--timeline">
            <div className="bump-chart-previous-stack">
              {columns.slice(0, -1).map((column, index, previousColumns) => (
                <BumpStage
                  key={column.id}
                  title={orderFallbackLabel(index, previousColumns.length + 1)}
                  name={column.name}
                  draft={column.draft}
                  onRename={(name) => renameColumn(column.id, name)}
                  onImport={() => setImportColumnId(column.id)}
                  onRemoveGroup={(groupId) =>
                    toggleGroupRemoval(column.id, groupId)
                  }
                  onRemoveItem={(groupId, itemIndex) =>
                    toggleItemRemoval(column.id, groupId, itemIndex)
                  }
                  onEditItem={(groupId, itemIndex, item) =>
                    setEditTarget({
                      scope: 'draft',
                      columnId: column.id,
                      groupId,
                      index: itemIndex,
                      item,
                    })
                  }
                  onOpenItemDetail={onOpenItemDetail}
                  onTogglePreserveCustomLabels={() =>
                    patchDraft(column.id, (draft) => ({
                      ...draft,
                      preserveCustomLabels: !draft.preserveCustomLabels,
                    }))
                  }
                  onClearAll={() =>
                    patchDraft(column.id, () => emptyDraft())
                  }
                  headingActions={
                    <div className="bump-chart-column-actions">
                      <button
                        type="button"
                        className="btn small"
                        disabled={index === 0}
                        onClick={() => moveOrder(column.id, -1)}
                        aria-label={`Move Previous order ${index + 1} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => moveOrder(column.id, 1)}
                        aria-label={`Move Previous order ${index + 1} down`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={previousColumns.length === 1}
                        onClick={() => removePreviousOrder(column.id)}
                        aria-label={`Remove Previous order ${index + 1}`}
                      >
                        Remove
                      </button>
                    </div>
                  }
                />
              ))}
            </div>
            <div className="bump-chart-current-column">
              {currentDraftColumn && (
                <BumpStage
                  title="Current order"
                  name={currentDraftColumn.name}
                  draft={currentDraftColumn.draft}
                  onRename={(name) =>
                    renameColumn(currentDraftColumn.id, name)
                  }
                  onImport={() => setImportColumnId(currentDraftColumn.id)}
                  onRemoveGroup={(groupId) =>
                    toggleGroupRemoval(currentDraftColumn.id, groupId)
                  }
                  onRemoveItem={(groupId, itemIndex) =>
                    toggleItemRemoval(
                      currentDraftColumn.id,
                      groupId,
                      itemIndex,
                    )
                  }
                  onEditItem={(groupId, itemIndex, item) =>
                    setEditTarget({
                      scope: 'draft',
                      columnId: currentDraftColumn.id,
                      groupId,
                      index: itemIndex,
                      item,
                    })
                  }
                  onOpenItemDetail={onOpenItemDetail}
                  onTogglePreserveCustomLabels={() =>
                    patchDraft(currentDraftColumn.id, (draft) => ({
                      ...draft,
                      preserveCustomLabels: !draft.preserveCustomLabels,
                    }))
                  }
                  onClearAll={() =>
                    patchDraft(currentDraftColumn.id, () => emptyDraft())
                  }
                  headingActions={
                    <div className="bump-chart-column-actions">
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => moveOrder(currentDraftColumn.id, -1)}
                        aria-label="Move Current order up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled
                        aria-label="Move Current order down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={columns.length <= 2}
                        onClick={removeCurrentOrder}
                        aria-label="Remove Current order"
                      >
                        Remove
                      </button>
                    </div>
                  }
                />
              )}
              <button
                type="button"
                className="bump-chart-add-column"
                onClick={addCurrentOrder}
                aria-label="Add current order"
                title="Add current order"
              >
                <span className="bump-chart-add-column-symbol" aria-hidden="true">
                  +
                </span>
              </button>
            </div>
          </div>
          <div className="bump-chart-generate-row">
            <button type="button" className="btn" onClick={clearStaged}>
              Clear all staged
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                pendingImports > 0 ||
                columns.some(
                  ({ id }) => (draftItemsByColumn.get(id)?.length ?? 0) === 0,
                )
              }
              onClick={generateChart}
            >
              {pendingImports > 0 ? 'Preparing imports…' : 'Generate chart'}
            </button>
          </div>
          {importError && <p className="tool-error">{importError}</p>}
        </>
      ) : (
        <>
          <div className="bump-chart-toolbar">
            <button
              type="button"
              className="btn"
              onClick={clearChart}
            >
              Clear chart
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setSaveModalOpen(true)}
            >
              Save chart…
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={exporting}
              onClick={() => {
                void exportPng();
              }}
            >
              {exporting
                ? exportProgress
                  ? `Preparing images ${exportProgress}…`
                  : 'Exporting…'
                : 'Export PNG'}
            </button>
          </div>
          {exportError && <p className="tool-error">{exportError}</p>}
          <BumpChart
            columns={renderedChartColumns}
            bestMatchByTitle={toolsPreferences.bumpChartBestMatchByTitle}
            panelProps={panelProps}
            chartRef={chartRef}
            onEdit={(columnId, index, item) => {
              const sourceIndex = visibleChartColumns
                .find(({ column }) => column.id === columnId)
                ?.visible[index]?.sourceIndex;
              if (sourceIndex == null) {
                return;
              }
              setEditTarget({
                scope: 'chart',
                columnId,
                index: sourceIndex,
                item,
              });
            }}
          />
        </>
      )}

      {storageError && <p className="tool-error">{storageError}</p>}

      {importColumnId && importCallbacks && (
        <AddItemsModal
          engine="merge"
          existingIds={new Set()}
          hiddenRestoreIds={new Set()}
          dbSyncRevision={panelProps.dbSyncRevision}
          forcePreRanked
          initialTab={importTab}
          onTabChange={(tab) => {
            importTabTouchedBeforeHydration.current = true;
            markWorkspaceMutation();
            setImportTab(tab);
          }}
          onCancel={closeImporter}
          {...importCallbacks}
        />
      )}

      {editTarget && (
        <EditItemModal
          item={editTarget.item}
          currentId={editTarget.item.id}
          otherIds={otherItemIds(editTarget, columns, chart)}
          allowEditId
          onCancel={() => setEditTarget(null)}
          onSave={saveEdit}
          secondaryAction={
            editTarget.scope === 'chart'
              ? {
                  label: 'Remove',
                  onClick: hideEditedChartItems,
                  tone: 'danger',
                }
              : undefined
          }
        />
      )}

      {saveModalOpen && (
        <SaveBumpChartModal
          onCancel={() => setSaveModalOpen(false)}
          onSave={saveCurrentChart}
        />
      )}
    </section>
  );
}
