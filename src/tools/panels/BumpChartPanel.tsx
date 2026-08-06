import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AddItemsModal,
  type AddItemsModalTab,
} from '../../components/AddItemsModal';
import {
  EditItemModal,
  type EditItemSavePayload,
} from '../../components/EditItemModal';
import { InfoIcon } from '../../components/icons';
import { Modal } from '../../components/Modal';
import {
  StagedItemsPanel,
  type StagedGroup,
  type StagedRemovalMarkers,
} from '../../components/StagedItemsPanel';
import { updateItemMetadata } from '../../lib/engine';
import { AnilistMiddleClickLink } from '../../lib/importers/anilist/AnilistMiddleClickLink';
import type { Item } from '../../lib/types';
import type { OrderedSlotImport } from '../../components/SortResultsImportMode';
import type { ToolPanelProps } from '../toolTypes';
import { useToolsPreferences } from '../../hooks/useToolsPreferences';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import {
  BUMP_CHART_COLORS,
  buildBumpConnections,
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

type GeneratedBumpChart = {
  left: BumpChartItem[];
  right: BumpChartItem[];
  hiddenLeftItemIds: Set<string>;
  hiddenRightItemIds: Set<string>;
  preserveLeftCustomLabels: boolean;
  preserveRightCustomLabels: boolean;
};

type EditTarget =
  | {
      scope: 'draft';
      side: ChartSide;
      groupId: string;
      index: number;
      item: Item;
    }
  | {
      scope: 'chart';
      side: ChartSide;
      index: number;
      item: Item;
    };

const EMPTY_DRAFT: BumpSideDraft = {
  groups: [],
  preserveCustomLabels: false,
};

let nextStageId = 1;

function stageId(): string {
  const id = nextStageId;
  nextStageId += 1;
  return `bump-stage-${id}`;
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

function chartSideToSnapshot(
  chart: GeneratedBumpChart,
  side: ChartSide,
): BumpChartSideSnapshot {
  return side === 'left'
    ? {
        items: chart.left,
        hiddenItemIds: [...chart.hiddenLeftItemIds],
        preserveCustomLabels: chart.preserveLeftCustomLabels,
      }
    : {
        items: chart.right,
        hiddenItemIds: [...chart.hiddenRightItemIds],
        preserveCustomLabels: chart.preserveRightCustomLabels,
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
    left: workspace.before.items,
    right: workspace.after.items,
    hiddenLeftItemIds: new Set(workspace.before.hiddenItemIds),
    hiddenRightItemIds: new Set(workspace.after.hiddenItemIds),
    preserveLeftCustomLabels: workspace.before.preserveCustomLabels,
    preserveRightCustomLabels: workspace.after.preserveCustomLabels,
  };
}

function workspaceFromState(
  before: BumpSideDraft,
  after: BumpSideDraft,
  chart: GeneratedBumpChart | null,
  bestMatchByTitle: boolean,
  lastImportTab: AddItemsModalTab,
): BumpChartWorkspaceSnapshot {
  return {
    version: 1,
    view: chart ? 'chart' : 'staging',
    before: chart ? chartSideToSnapshot(chart, 'left') : draftToSnapshot(before),
    after: chart ? chartSideToSnapshot(chart, 'right') : draftToSnapshot(after),
    bestMatchByTitle,
    lastImportTab,
  };
}

function applyItemEdit(item: Item, payload: EditItemSavePayload): Item {
  const updated = updateItemMetadata(item, {
    label: payload.label,
    url: payload.url,
    imageUrl: payload.imageUrl,
    useAutomaticAnilistLabel: payload.useAutomaticAnilistLabel,
  });
  return payload.id && payload.id !== updated.id
    ? { ...updated, id: payload.id }
    : updated;
}

function otherItemIds(
  target: EditTarget,
  before: BumpSideDraft,
  after: BumpSideDraft,
  chart: GeneratedBumpChart | null,
): Map<string, string> {
  const ids = new Map<string, string>();
  if (target.scope === 'draft') {
    const draft = target.side === 'left' ? before : after;
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
    target.side === 'left' ? chart?.left ?? [] : chart?.right ?? [];
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
}: {
  item: Item;
  side: ChartSide;
  panelProps: ToolPanelProps;
}) {
  return (
    <AnilistMiddleClickLink
      url={item.url ?? null}
      className={`bump-chart-item-link bump-chart-item-link--${side}`}
      onPrimaryClick={
        canOpenDetail(item) ? () => openItemDetail(item, panelProps) : undefined
      }
      title={
        canOpenDetail(item)
          ? `${item.label} (middle-click to open source)`
          : item.label
      }
    >
      {item.imageUrl && <img src={item.imageUrl} alt="" loading="lazy" />}
      <span className="bump-chart-label">{item.label}</span>
    </AnilistMiddleClickLink>
  );
}

function BumpStage({
  title,
  draft,
  onImport,
  onRemoveGroup,
  onRemoveItem,
  onEditItem,
  onOpenItemDetail,
  onTogglePreserveCustomLabels,
  onClearAll,
}: {
  title: string;
  draft: BumpSideDraft;
  onImport: () => void;
  onRemoveGroup: (groupId: string) => void;
  onRemoveItem: (groupId: string, index: number) => void;
  onEditItem: (groupId: string, index: number, item: Item) => void;
  onOpenItemDetail: (item: Item) => void;
  onTogglePreserveCustomLabels: () => void;
  onClearAll: () => void;
}) {
  const deduped = itemsInDraft(draft);
  const hasCustomLabels = hasCustomAnilistLabels(deduped);
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
          <h3>{title}</h3>
          <p>Each import is appended in pre-ranked order.</p>
        </div>
        <button type="button" className="btn primary" onClick={onImport}>
          Import ranked items
        </button>
      </div>

      {hasCustomLabels && (
        <div className="bump-chart-import-action-row">
          <label className="checkbox-row bump-chart-preserve-labels">
            <input
              type="checkbox"
              checked={draft.preserveCustomLabels}
              onChange={onTogglePreserveCustomLabels}
            />
            Preserve custom labels
            <span
              className="bump-chart-help-tooltip"
              title="When off, hydrated AniList items use the current display-language setting."
              aria-label="Preserve custom labels help"
            >
              ?
            </span>
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
  left: number;
  leftCenters: number[];
  rightCenters: number[];
};

function sameLayout(a: ChartLayout | null, b: ChartLayout): boolean {
  return (
    a?.width === b.width &&
    a.height === b.height &&
    a.left === b.left &&
    a.leftCenters.length === b.leftCenters.length &&
    a.rightCenters.length === b.rightCenters.length &&
    a.leftCenters.every((value, index) => value === b.leftCenters[index]) &&
    a.rightCenters.every((value, index) => value === b.rightCenters[index])
  );
}

function movementPath(
  connection: BumpConnection,
  width: number,
  leftCenters: readonly number[],
  rightCenters: readonly number[],
): string {
  const leftY =
    connection.leftIndex == null
      ? null
      : leftCenters[connection.leftIndex] ?? 0;
  const rightY =
    connection.rightIndex == null
      ? null
      : rightCenters[connection.rightIndex] ?? 0;
  if (connection.kind === 'removed') {
    return `M 12 ${leftY} L 42 ${leftY}`;
  }
  if (connection.kind === 'added') {
    return `M ${width - 42} ${rightY} L ${width - 12} ${rightY}`;
  }
  const control = width * 0.42;
  return `M 12 ${leftY} C ${control} ${leftY}, ${
    width - control
  } ${rightY}, ${width - 12} ${rightY}`;
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
const INFERRED_MARKER_MIN_NODE_SEPARATION = 26;

export function inferredMatchMarkerPosition(
  width: number,
  leftY: number,
  rightY: number,
): { x: number; y: number; pathPosition: number; nodeSeparation: number } {
  const control = width * 0.42;
  const pointAt = (pathPosition: number): { x: number; y: number } => ({
    x: cubicCoordinate(
      12,
      control,
      width - control,
      width - 12,
      pathPosition,
    ),
    y: cubicCoordinate(leftY, leftY, rightY, rightY, pathPosition),
  });
  const rightNode = { x: width - 12, y: rightY };
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
  width,
  leftY,
  rightY,
}: {
  connection: BumpConnection;
  width: number;
  leftY: number;
  rightY: number;
}) {
  const { x, y, pathPosition, nodeSeparation } =
    inferredMatchMarkerPosition(width, leftY, rightY);
  const description =
    connection.matchBasis === 'alternate-title'
      ? 'Inferred match from an AniList title variant'
      : 'Inferred match from an exact label';
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
      <InfoIcon
        className="bump-chart-inferred-icon"
        x={x - 9}
        y={y - 9}
        size={18}
      />
    </g>
  );
}

function BumpChartLabel({
  side,
  item,
  rank,
  connection,
  focusedKey,
  panelProps,
  onFocus,
  onEdit,
}: {
  side: ChartSide;
  item: Item;
  rank: number;
  connection: BumpConnection | undefined;
  focusedKey: string | null;
  panelProps: ToolPanelProps;
  onFocus: (key: string | null) => void;
  onEdit: () => void;
}) {
  const dimmed = focusedKey != null && connection?.key !== focusedKey;
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
      onMouseEnter={() => onFocus(connection?.key ?? null)}
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

type LoadedCanvasImage = {
  source: CanvasImageSource;
  dispose: () => void;
};

const ANILIST_IMAGE_HOST = 's4.anilist.co';

export function canvasImageFetchUrls(
  src: string,
  configuredProxyUrl = import.meta.env.VITE_ANIPLAYLIST_PROXY_URL?.trim() ?? '',
  useLocalProxy = import.meta.env.DEV,
): string[] {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(src);
  } catch {
    return [src];
  }
  if (sourceUrl.hostname !== ANILIST_IMAGE_HOST) {
    return [src];
  }

  const sourcePath = `${sourceUrl.pathname}${sourceUrl.search}`;
  const fetchUrls = [src];
  if (configuredProxyUrl) {
    try {
      const proxyUrl = new URL(configuredProxyUrl);
      const basePath = proxyUrl.pathname.replace(/\/+$/, '');
      proxyUrl.pathname = `${basePath}/image`;
      proxyUrl.search = '';
      proxyUrl.hash = '';
      proxyUrl.searchParams.set('path', sourcePath);
      fetchUrls.push(proxyUrl.toString());
    } catch {
      // Fall through to the local proxy when a development override is invalid.
    }
  }
  if (useLocalProxy) {
    fetchUrls.push(`/api/anilist-image${sourcePath}`);
  }
  return fetchUrls;
}

async function decodeCanvasImage(blob: Blob): Promise<LoadedCanvasImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, dispose: () => bitmap.close() };
    } catch {
      // Some browsers expose createImageBitmap but cannot decode every format.
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Image decode failed.'));
      element.src = objectUrl;
    });
    return {
      source: image,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function loadCanvasImage(src: string): Promise<LoadedCanvasImage | null> {
  for (const fetchUrl of canvasImageFetchUrls(src)) {
    try {
      const response = await fetch(fetchUrl, { mode: 'cors' });
      if (!response.ok) {
        continue;
      }
      return await decodeCanvasImage(await response.blob());
    } catch {
      // AniList's CDN omits CORS headers; retry its image through our proxy.
    }
  }
  return null;
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
  const cell = element.closest<HTMLElement>('.bump-chart-label-cell');
  const opacity = Number(cell ? getComputedStyle(cell).opacity : 1);
  return Number.isFinite(opacity) ? opacity : 1;
}

export async function exportChartPng(node: HTMLElement): Promise<void> {
  const rootRect = node.getBoundingClientRect();
  const width = Math.ceil(rootRect.width);
  const height = Math.ceil(rootRect.height);
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
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

  for (const row of node.querySelectorAll<HTMLElement>('.bump-chart-row')) {
    const rowRect = row.getBoundingClientRect();
    const center = row.querySelector<HTMLElement>('.bump-chart-center-cell');
    if (center) {
      const centerRect = center.getBoundingClientRect();
      context.fillStyle = getComputedStyle(center).backgroundColor;
      context.fillRect(
        centerRect.left - rootRect.left,
        rowRect.top - rootRect.top,
        centerRect.width,
        rowRect.height,
      );
    }
    context.strokeStyle = getComputedStyle(row).borderBottomColor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, rowRect.bottom - rootRect.top - 0.5);
    context.lineTo(width, rowRect.bottom - rootRect.top - 0.5);
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
    const movementBadge = svg.querySelector<SVGGElement>(
      '.bump-chart-movement-badge',
    );
    const badgeRect =
      movementBadge?.querySelector<SVGRectElement>('rect') ?? null;
    const badgeText =
      movementBadge?.querySelector<SVGTextElement>('text') ?? null;
    const badgeX = Number(movementBadge?.dataset.badgeX);
    const badgeY = Number(movementBadge?.dataset.badgeY);
    const badgeWidth = Number(movementBadge?.dataset.badgeWidth);
    const badgeLabel = movementBadge?.dataset.badgeLabel;
    if (
      movementBadge &&
      badgeRect &&
      badgeText &&
      badgeLabel &&
      Number.isFinite(badgeX) &&
      Number.isFinite(badgeY) &&
      Number.isFinite(badgeWidth)
    ) {
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

  const imageElements = Array.from(
    node.querySelectorAll<HTMLImageElement>('.bump-chart-item-link img'),
  );
  const loadedImages = await Promise.all(
    imageElements.map((image) =>
      loadCanvasImage(image.currentSrc || image.src),
    ),
  );
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
    loaded.dispose();
  });

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

function BumpChart({
  left,
  right,
  matchingLeft,
  matchingRight,
  bestMatchByTitle,
  panelProps,
  onEdit,
  chartRef,
}: {
  left: readonly BumpChartItem[];
  right: readonly BumpChartItem[];
  matchingLeft: readonly BumpChartItem[];
  matchingRight: readonly BumpChartItem[];
  bestMatchByTitle: boolean;
  panelProps: ToolPanelProps;
  onEdit: (side: ChartSide, index: number, item: Item) => void;
  chartRef: React.RefObject<HTMLDivElement>;
}) {
  const connections = useMemo(
    () =>
      buildBumpConnections(matchingLeft, matchingRight, { bestMatchByTitle }),
    [bestMatchByTitle, matchingLeft, matchingRight],
  );
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [layout, setLayout] = useState<ChartLayout | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const rowCount = Math.max(left.length, right.length);

  const leftConnectionByIndex = useMemo(
    () =>
      new Map(
        connections
          .filter(
            (connection): connection is BumpConnection & { leftIndex: number } =>
              connection.leftIndex != null,
          )
          .map((connection) => [connection.leftIndex, connection]),
      ),
    [connections],
  );
  const rightConnectionByIndex = useMemo(
    () =>
      new Map(
        connections
          .filter(
            (
              connection,
            ): connection is BumpConnection & { rightIndex: number } =>
              connection.rightIndex != null,
          )
          .map((connection) => [connection.rightIndex, connection]),
      ),
    [connections],
  );
  const focusedKey = pinnedKey ?? hoveredKey;
  const focusedConnection =
    focusedKey == null
      ? null
      : connections.find((connection) => connection.key === focusedKey) ?? null;
  const focusedMovement =
    focusedConnection == null
      ? null
      : bumpConnectionMovement(focusedConnection);
  const focusedLeftY =
    layout != null && focusedConnection?.leftIndex != null
      ? layout.leftCenters[focusedConnection.leftIndex]
      : null;
  const focusedRightY =
    layout != null && focusedConnection?.rightIndex != null
      ? layout.rightCenters[focusedConnection.rightIndex]
      : null;

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || !chartRef.current?.contains(target)) {
        return;
      }
      const connectionElement =
        target.closest<HTMLElement>('[data-bump-lineage]');
      if (connectionElement) {
        setPinnedKey(connectionElement.dataset.bumpLineage ?? null);
      } else {
        setPinnedKey(null);
      }
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [chartRef]);

  useEffect(() => {
    if (
      pinnedKey != null &&
      !connections.some((connection) => connection.key === pinnedKey)
    ) {
      setPinnedKey(null);
    }
  }, [connections, pinnedKey]);

  useLayoutEffect(() => {
    const root = chartRef.current;
    if (!root) {
      return;
    }
    const measure = (): void => {
      const rootRect = root.getBoundingClientRect();
      const rows = rowRefs.current.slice(0, rowCount);
      const firstCenter = rows[0]?.querySelector<HTMLElement>(
        '.bump-chart-center-cell',
      );
      const centerRect = firstCenter?.getBoundingClientRect();
      if (!centerRect) {
        return;
      }
      const rowRects = rows.map((row) => {
        const rect = row?.getBoundingClientRect();
        return {
          top: rect?.top ?? rootRect.top,
          height: rect?.height ?? 0,
        };
      });
      const centers = bumpRowCenterOffsets(rootRect.top, rowRects);
      const next: ChartLayout = {
        width: centerRect.width,
        // The absolute SVG must not keep its previous zoomed height alive.
        height: rootRect.height,
        left: centerRect.left - rootRect.left,
        leftCenters: left.map((_, index) => centers[index] ?? 0),
        rightCenters: right.map((_, index) => centers[index] ?? 0),
      };
      setLayout((current) => (sameLayout(current, next) ? current : next));
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    rowRefs.current.slice(0, rowCount).forEach((row) => {
      if (row) {
        observer?.observe(row);
      }
    });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [chartRef, left, right, rowCount]);

  return (
    <div className="tool-chart-fullbleed bump-chart-fullbleed">
      <div className="bump-chart-grid" ref={chartRef}>
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            key={`row:${index}`}
            ref={(element) => {
              rowRefs.current[index] = element;
            }}
            className="bump-chart-row"
          >
            {left[index] ? (
              <BumpChartLabel
                side="left"
                item={left[index]!.item}
                rank={index + 1}
                connection={leftConnectionByIndex.get(index)}
                focusedKey={focusedKey}
                panelProps={panelProps}
                onFocus={setHoveredKey}
                onEdit={() => onEdit('left', index, left[index]!.item)}
              />
            ) : (
              <div className="bump-chart-label-cell bump-chart-label-cell--empty" />
            )}
            <div className="bump-chart-center-cell" aria-hidden="true" />
            {right[index] ? (
              <BumpChartLabel
                side="right"
                item={right[index]!.item}
                rank={index + 1}
                connection={rightConnectionByIndex.get(index)}
                focusedKey={focusedKey}
                panelProps={panelProps}
                onFocus={setHoveredKey}
                onEdit={() => onEdit('right', index, right[index]!.item)}
              />
            ) : (
              <div className="bump-chart-label-cell bump-chart-label-cell--empty" />
            )}
          </div>
        ))}
        {layout && (
          <svg
            className="bump-chart-svg"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="none"
            aria-label="Rank movement chart"
            style={{
              left: layout.left,
              width: layout.width,
              height: layout.height,
            }}
          >
            {Array.from({ length: rowCount }, (_, index) => {
              const y =
                layout.leftCenters[index] ??
                layout.rightCenters[index] ??
                0;
              return (
                <line
                  key={`guide:${index}`}
                  className="bump-chart-guide"
                  x1="0"
                  y1={y}
                  x2={layout.width}
                  y2={y}
                />
              );
            })}
            {connections.map((connection) => {
              const path = movementPath(
                connection,
                layout.width,
                layout.leftCenters,
                layout.rightCenters,
              );
              const color = BUMP_CHART_COLORS[connection.colorIndex]!;
              const dimmed =
                focusedKey != null && focusedKey !== connection.key;
              const active = focusedKey === connection.key;
              const leftY =
                connection.leftIndex == null
                  ? null
                  : layout.leftCenters[connection.leftIndex];
              const rightY =
                connection.rightIndex == null
                  ? null
                  : layout.rightCenters[connection.rightIndex];
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
                  style={{ color }}
                  onMouseEnter={() => setHoveredKey(connection.key)}
                  onMouseLeave={() => setHoveredKey(null)}
                >
                  <path
                    className="bump-chart-path-hit"
                    d={path}
                    data-bump-lineage={connection.key}
                  />
                  <path
                    className="bump-chart-path"
                    d={path}
                    data-bump-lineage={connection.key}
                  />
                  {leftY != null && (
                    <circle
                      className="bump-chart-node"
                      cx="12"
                      cy={leftY}
                      r="6"
                      data-bump-lineage={connection.key}
                    />
                  )}
                  {rightY != null && (
                    <circle
                      className="bump-chart-node"
                      cx={layout.width - 12}
                      cy={rightY}
                      r="6"
                      data-bump-lineage={connection.key}
                    />
                  )}
                  {connection.kind === 'removed' && leftY != null && (
                    <ChangeMarker kind="removed" x={55} y={leftY} />
                  )}
                  {connection.kind === 'added' && rightY != null && (
                    <ChangeMarker
                      kind="added"
                      x={layout.width - 55}
                      y={rightY}
                    />
                  )}
                  {connection.matchBasis !== 'logical-id' &&
                    connection.matchBasis != null &&
                    leftY != null &&
                    rightY != null && (
                      <InferredMatchMarker
                        connection={connection}
                        width={layout.width}
                        leftY={leftY}
                        rightY={rightY}
                      />
                    )}
                </g>
              );
            })}
            {focusedMovement != null &&
              focusedLeftY != null &&
              focusedRightY != null && (
                <MovementBadge
                  movement={focusedMovement}
                  x={layout.width / 2}
                  y={(focusedLeftY + focusedRightY) / 2}
                />
              )}
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
  if (slots.length === 0) {
    return null;
  }
  return (
    <section className="tool-form-card bump-chart-saved-charts">
      <div className="bump-chart-saved-heading">
        <div>
          <h3>Saved charts</h3>
          <p>Named snapshots are separate from your autosaved workspace.</p>
        </div>
        <span>{slots.length} saved</span>
      </div>
      <div className="bump-chart-saved-list">
        {slots.map((slot) => (
          <div className="bump-chart-saved-row" key={slot.id}>
            <span className="bump-chart-saved-name">{slot.name}</span>
            <span className="bump-chart-saved-date">
              {new Date(slot.updatedAt).toLocaleDateString()}
            </span>
            {deletingId === slot.id ? (
              <div className="bump-chart-saved-actions">
                <button type="button" className="btn small" onClick={onCancelDelete}>
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
  const [before, setBefore] = useState<BumpSideDraft>(EMPTY_DRAFT);
  const [after, setAfter] = useState<BumpSideDraft>(EMPTY_DRAFT);
  const [importSide, setImportSide] = useState<ChartSide | null>(null);
  const [importTab, setImportTab] = useState<AddItemsModalTab>('single');
  const [chart, setChart] = useState<GeneratedBumpChart | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [pendingImports, setPendingImports] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedCharts, setSavedCharts] = useState<SavedBumpChartMeta[]>([]);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [deletingSavedId, setDeletingSavedId] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const latestWorkspaceRef = useRef<BumpChartWorkspaceSnapshot | null>(null);
  const importTabTouchedBeforeHydration = useRef(false);
  if (
    storageHydrated ||
    before.groups.length > 0 ||
    after.groups.length > 0 ||
    chart !== null ||
    importTab !== 'single'
  ) {
    latestWorkspaceRef.current = workspaceFromState(
      before,
      after,
      chart,
      toolsPreferences.bumpChartBestMatchByTitle,
      importTab,
    );
  }

  useEffect(() => {
    let cancelled = false;
    void initializeBumpChartStorage().then(() => {
      if (cancelled) return;
      const workspace = loadActiveBumpChartWorkspace();
      if (workspace?.view === 'staging') {
        setBefore(draftFromSnapshot(workspace.before, 'Restored workspace'));
        setAfter(draftFromSnapshot(workspace.after, 'Restored workspace'));
        setChart(null);
      } else if (workspace) {
        setBefore(EMPTY_DRAFT);
        setAfter(EMPTY_DRAFT);
        setChart(chartFromSnapshot(workspace));
      }
      if (workspace) {
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
      before,
      after,
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
    after,
    before,
    chart,
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
      void refreshBumpChartStorage().then(() => {
        setSavedCharts(listSavedBumpCharts());
        if (revision?.id !== 'active') return;
        const workspace = loadActiveBumpChartWorkspace();
        if (!workspace) return;
        setImportTab(workspace.lastImportTab);
        setBumpChartBestMatchByTitle(workspace.bestMatchByTitle);
        if (workspace.view === 'chart') {
          setBefore(EMPTY_DRAFT);
          setAfter(EMPTY_DRAFT);
          setChart(chartFromSnapshot(workspace));
        } else {
          setBefore(draftFromSnapshot(workspace.before, 'Restored workspace'));
          setAfter(draftFromSnapshot(workspace.after, 'Restored workspace'));
          setChart(null);
        }
      });
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setBumpChartBestMatchByTitle]);

  const appendGroup = useCallback(
    async (
      side: ChartSide,
      source: string,
      incoming: BumpChartItem[],
    ): Promise<void> => {
      const setDraft = side === 'left' ? setBefore : setAfter;
      setPendingImports((count) => count + 1);
      setImportError(null);
      try {
        const hydrated = await hydrateBumpChartItems(incoming);
        if (hydrated.length === 0) {
          return;
        }
        setDraft((draft) => ({
          ...draft,
          groups: [
            ...draft.groups,
            { id: stageId(), source, items: hydrated },
          ],
        }));
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : 'Item import failed.',
        );
      } finally {
        setPendingImports((count) => Math.max(0, count - 1));
      }
    },
    [],
  );

  const closeImporter = (): void => setImportSide(null);

  const importCallbacks =
    importSide == null
      ? null
      : {
          onAddOne: (item: Item) => {
            void appendGroup(
              importSide,
              'Single item',
              bumpItemsFromImportedItems([item]),
            );
            closeImporter();
          },
          onAddMany: (items: Item[]) => {
            void appendGroup(
              importSide,
              'AniList selection',
              bumpItemsFromImportedItems(items),
            );
            closeImporter();
          },
          onAddPreRanked: (items: Item[]) => {
            void appendGroup(
              importSide,
              'Pasted / CSV list',
              bumpItemsFromImportedItems(items),
            );
            closeImporter();
          },
          onImportOrderedItems: (imports: OrderedSlotImport[]) => {
            void (async () => {
              for (const entry of imports) {
                await appendGroup(
                  importSide,
                  entry.source,
                  bumpItemsFromSortResults(entry.items),
                );
              }
            })();
            closeImporter();
          },
        };

  const patchDraft = (
    side: ChartSide,
    update: (draft: BumpSideDraft) => BumpSideDraft,
  ): void => {
    (side === 'left' ? setBefore : setAfter)((draft) => {
      const next = update(draft);
      return hasCustomAnilistLabels(itemsInDraft(next))
        ? next
        : { ...next, preserveCustomLabels: false };
    });
  };

  const toggleGroupRemoval = (side: ChartSide, groupId: string): void => {
    (side === 'left' ? setBefore : setAfter)((draft) => ({
      ...draft,
      groups: draft.groups.map((group) =>
        group.id === groupId
          ? { ...group, markedForRemoval: !group.markedForRemoval }
          : group,
      ),
    }));
  };

  const toggleItemRemoval = (
    side: ChartSide,
    groupId: string,
    index: number,
  ): void => {
    (side === 'left' ? setBefore : setAfter)((draft) => ({
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

  const leftDraftItems = itemsInDraft(before);
  const rightDraftItems = itemsInDraft(after);
  const visibleLeft = useMemo(
    () =>
      chart?.left.flatMap((entry, sourceIndex) =>
        chart.hiddenLeftItemIds.has(entry.item.id)
          ? []
          : [{ entry, sourceIndex }],
      ) ?? [],
    [chart],
  );
  const visibleRight = useMemo(
    () =>
      chart?.right.flatMap((entry, sourceIndex) =>
        chart.hiddenRightItemIds.has(entry.item.id)
          ? []
          : [{ entry, sourceIndex }],
      ) ?? [],
    [chart],
  );
  const left = useMemo(
    () =>
      chart
        ? displayBumpChartItems(
            visibleLeft.map(({ entry }) => entry),
            chart.preserveLeftCustomLabels,
          )
        : [],
    [chart, displayLabelRevision, visibleLeft],
  );
  const right = useMemo(
    () =>
      chart
        ? displayBumpChartItems(
            visibleRight.map(({ entry }) => entry),
            chart.preserveRightCustomLabels,
          )
        : [],
    [chart, displayLabelRevision, visibleRight],
  );

  const generateChart = (): void => {
    const beforeSnapshot = draftToSnapshot(before);
    const afterSnapshot = draftToSnapshot(after);
    setChart({
      left: beforeSnapshot.items,
      right: afterSnapshot.items,
      hiddenLeftItemIds: new Set(beforeSnapshot.hiddenItemIds),
      hiddenRightItemIds: new Set(afterSnapshot.hiddenItemIds),
      preserveLeftCustomLabels: before.preserveCustomLabels,
      preserveRightCustomLabels: after.preserveCustomLabels,
    });
    setBefore(EMPTY_DRAFT);
    setAfter(EMPTY_DRAFT);
    setImportSide(null);
    setImportError(null);
    setExportError(null);
  };

  const saveEdit = (payload: EditItemSavePayload): void => {
    if (!editTarget) {
      return;
    }
    const updated = applyItemEdit(editTarget.item, payload);
    if (editTarget.scope === 'draft') {
      patchDraft(editTarget.side, (draft) => ({
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
                    ? {
                        ...entry,
                        item: updated,
                        logicalId: entry.logicalId
                          ? updated.id
                          : entry.logicalId,
                      }
                    : entry,
                ),
              }
            : group,
        ),
      }));
    } else {
      setChart((current) => {
        if (!current) {
          return current;
        }
        const key = editTarget.side === 'left' ? 'left' : 'right';
        return {
          ...current,
          [key]: current[key].map((entry, index) =>
            index === editTarget.index
              ? {
                  ...entry,
                  item: updated,
                  logicalId: entry.logicalId ? updated.id : entry.logicalId,
                }
              : entry,
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
    setChart((current) => {
      if (!current) {
        return current;
      }
      const hiddenLeftItemIds = new Set(current.hiddenLeftItemIds);
      const hiddenRightItemIds = new Set(current.hiddenRightItemIds);
      const entry =
        editTarget.side === 'left'
          ? current.left[editTarget.index]
          : current.right[editTarget.index];
      if (!entry) {
        return current;
      }
      (editTarget.side === 'left'
        ? hiddenLeftItemIds
        : hiddenRightItemIds
      ).add(entry.item.id);
      return { ...current, hiddenLeftItemIds, hiddenRightItemIds };
    });
    setEditTarget(null);
  };

  const clearChart = (): void => {
    if (!chart) {
      return;
    }
    setBefore(
      draftFromSnapshot(chartSideToSnapshot(chart, 'left'), 'From chart'),
    );
    setAfter(
      draftFromSnapshot(chartSideToSnapshot(chart, 'right'), 'From chart'),
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
    setBefore(draftFromSnapshot(workspace.before, 'From saved chart'));
    setAfter(draftFromSnapshot(workspace.after, 'From saved chart'));
    setChart(null);
    setBumpChartBestMatchByTitle(workspace.bestMatchByTitle);
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
        before,
        after,
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
    setExportError(null);
    try {
      await exportChartPng(chartRef.current);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'PNG export failed.',
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="tool-panel bump-chart-panel">
      <p className="tool-panel-lead">
        Stage two ranked lists, then generate a chart of items moving up,
        down, on, or off the ranking.
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
          <div className="bump-chart-import-grid">
            <BumpStage
              title="Previous order"
              draft={before}
              onImport={() => setImportSide('left')}
              onRemoveGroup={(groupId) =>
                toggleGroupRemoval('left', groupId)
              }
              onRemoveItem={(groupId, index) =>
                toggleItemRemoval('left', groupId, index)
              }
              onEditItem={(groupId, index, item) =>
                setEditTarget({
                  scope: 'draft',
                  side: 'left',
                  groupId,
                  index,
                  item,
                })
              }
              onOpenItemDetail={onOpenItemDetail}
              onTogglePreserveCustomLabels={() =>
                setBefore((draft) => ({
                  ...draft,
                  preserveCustomLabels: !draft.preserveCustomLabels,
                }))
              }
              onClearAll={() => setBefore(EMPTY_DRAFT)}
            />
            <BumpStage
              title="Current order"
              draft={after}
              onImport={() => setImportSide('right')}
              onRemoveGroup={(groupId) =>
                toggleGroupRemoval('right', groupId)
              }
              onRemoveItem={(groupId, index) =>
                toggleItemRemoval('right', groupId, index)
              }
              onEditItem={(groupId, index, item) =>
                setEditTarget({
                  scope: 'draft',
                  side: 'right',
                  groupId,
                  index,
                  item,
                })
              }
              onOpenItemDetail={onOpenItemDetail}
              onTogglePreserveCustomLabels={() =>
                setAfter((draft) => ({
                  ...draft,
                  preserveCustomLabels: !draft.preserveCustomLabels,
                }))
              }
              onClearAll={() => setAfter(EMPTY_DRAFT)}
            />
          </div>
          <div className="bump-chart-generate-row">
            <button
              type="button"
              className="btn primary"
              disabled={
                pendingImports > 0 ||
                leftDraftItems.length === 0 ||
                rightDraftItems.length === 0
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
              {exporting ? 'Exporting…' : 'Export PNG'}
            </button>
          </div>
          {exportError && <p className="tool-error">{exportError}</p>}
          <BumpChart
            left={left}
            right={right}
            matchingLeft={visibleLeft.map(({ entry }) => entry)}
            matchingRight={visibleRight.map(({ entry }) => entry)}
            bestMatchByTitle={toolsPreferences.bumpChartBestMatchByTitle}
            panelProps={panelProps}
            chartRef={chartRef}
            onEdit={(side, index, item) => {
              const sourceIndex =
                side === 'left'
                  ? visibleLeft[index]?.sourceIndex
                  : visibleRight[index]?.sourceIndex;
              if (sourceIndex == null) {
                return;
              }
              setEditTarget({
                scope: 'chart',
                side,
                index: sourceIndex,
                item,
              });
            }}
          />
        </>
      )}

      {storageError && <p className="tool-error">{storageError}</p>}

      {importSide && importCallbacks && (
        <AddItemsModal
          engine="merge"
          existingIds={new Set()}
          hiddenRestoreIds={new Set()}
          dbSyncRevision={panelProps.dbSyncRevision}
          forcePreRanked
          initialTab={importTab}
          onTabChange={(tab) => {
            importTabTouchedBeforeHydration.current = true;
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
          otherIds={otherItemIds(editTarget, before, after, chart)}
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
