import {
  useCallback,
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

function InteractiveItemLabel({
  item,
  side,
  panelProps,
}: {
  item: Item;
  side: ChartSide;
  panelProps: ToolPanelProps;
}) {
  const openDetail = (): void => {
    if (item.source?.kind === 'anilist') {
      panelProps.onOpenMedia(item.source.externalId, item.label);
    } else if (item.source?.kind === 'anilist-staff') {
      panelProps.onOpenStaff(item.source.externalId, item.label);
    }
  };
  return (
    <AnilistMiddleClickLink
      url={item.url ?? null}
      className={`bump-chart-item-link bump-chart-item-link--${side}`}
      onPrimaryClick={canOpenDetail(item) ? openDetail : undefined}
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
  onTogglePreserveCustomLabels,
  onClearAll,
}: {
  title: string;
  draft: BumpSideDraft;
  onImport: () => void;
  onRemoveGroup: (groupId: string) => void;
  onRemoveItem: (groupId: string, index: number) => void;
  onEditItem: (groupId: string, index: number, item: Item) => void;
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
        <span className="bump-chart-stage-count">
          {deduped.length} staged
        </span>
      </div>

      <div className="bump-chart-import-action-row">
        <button type="button" className="btn primary" onClick={onImport}>
          Import ranked items
        </button>
        {hasCustomLabels && (
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
        )}
      </div>

      <div className="bump-chart-staging-area">
        <div className="bump-chart-staging-title">Staging area</div>
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

async function loadCanvasImage(src: string): Promise<LoadedCanvasImage | null> {
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, dispose: () => bitmap.close() };
    }
    const objectUrl = URL.createObjectURL(blob);
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
  } catch {
    return null;
  }
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
      const color = getComputedStyle(group).color;
      const path = group.querySelector<SVGPathElement>('.bump-chart-path');
      const pathData = path?.getAttribute('d');
      if (pathData) {
        context.strokeStyle = color;
        context.lineWidth = 3;
        context.lineCap = 'round';
        context.stroke(new Path2D(pathData));
      }
      for (const circle of group.querySelectorAll<SVGCircleElement>(
        '.bump-chart-node, .bump-chart-change-marker circle',
      )) {
        context.fillStyle = backgroundColor;
        context.strokeStyle = color;
        context.lineWidth = circle.matches('.bump-chart-node') ? 3 : 2.5;
        context.beginPath();
        context.arc(
          circle.cx.baseVal.value,
          circle.cy.baseVal.value,
          circle.r.baseVal.value,
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
    drawCoverImage(
      context,
      loaded.source,
      imageRect.left - rootRect.left,
      imageRect.top - rootRect.top,
      imageRect.width,
      imageRect.height,
    );
    loaded.dispose();
  });

  for (const label of node.querySelectorAll<HTMLElement>(
    '.bump-chart-label',
  )) {
    drawElementText(context, label, rootRect);
  }
  for (const rank of node.querySelectorAll<HTMLElement>('.bump-chart-rank')) {
    drawElementText(context, rank, rootRect);
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
  panelProps,
  onEdit,
  chartRef,
}: {
  left: readonly BumpChartItem[];
  right: readonly BumpChartItem[];
  panelProps: ToolPanelProps;
  onEdit: (side: ChartSide, index: number, item: Item) => void;
  chartRef: React.RefObject<HTMLDivElement>;
}) {
  const connections = useMemo(
    () => buildBumpConnections(left, right),
    [left, right],
  );
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
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
        height: root.scrollHeight,
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
                onFocus={setFocusedKey}
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
                onFocus={setFocusedKey}
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
                  onMouseEnter={() => setFocusedKey(connection.key)}
                  onMouseLeave={() => setFocusedKey(null)}
                >
                  <path className="bump-chart-path-hit" d={path} />
                  <path className="bump-chart-path" d={path} />
                  {leftY != null && (
                    <circle
                      className="bump-chart-node"
                      cx="12"
                      cy={leftY}
                      r="6"
                    />
                  )}
                  {rightY != null && (
                    <circle
                      className="bump-chart-node"
                      cx={layout.width - 12}
                      cy={rightY}
                      r="6"
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

export function BumpChartPanel(panelProps: ToolPanelProps) {
  const displayLabelRevision = useToolsDisplayLabelRevision();
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
  const chartRef = useRef<HTMLDivElement>(null);

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
  const left = useMemo(
    () =>
      chart
        ? displayBumpChartItems(
            chart.left,
            chart.preserveLeftCustomLabels,
          )
        : [],
    [chart, displayLabelRevision],
  );
  const right = useMemo(
    () =>
      chart
        ? displayBumpChartItems(
            chart.right,
            chart.preserveRightCustomLabels,
          )
        : [],
    [chart, displayLabelRevision],
  );

  const generateChart = (): void => {
    setChart({
      left: leftDraftItems,
      right: rightDraftItems,
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
        label, URL, image, or ID.
      </p>

      {!chart ? (
        <>
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
              onClick={() => {
                setChart(null);
                setExportError(null);
              }}
            >
              Clear chart
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
            panelProps={panelProps}
            chartRef={chartRef}
            onEdit={(side, index, item) =>
              setEditTarget({ scope: 'chart', side, index, item })
            }
          />
        </>
      )}

      {importSide && importCallbacks && (
        <AddItemsModal
          engine="merge"
          existingIds={new Set()}
          hiddenRestoreIds={new Set()}
          dbSyncRevision={panelProps.dbSyncRevision}
          forcePreRanked
          initialTab={importTab}
          onTabChange={setImportTab}
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
        />
      )}
    </section>
  );
}
