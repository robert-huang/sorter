import {
  BUMP_CHART_DEFAULT_ZOOM,
  BUMP_CHART_ZOOM_DEBOUNCE_MS,
  BUMP_CHART_ZOOM_IN_PATH,
  BUMP_CHART_ZOOM_OUT_PATH,
  BUMP_CHART_ZOOM_STEPS,
} from './bumpChartZoom';

function readableStylesheets(): string {
  return Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules, (rule) => rule.cssText);
      } catch {
        // A cross-origin stylesheet cannot be read; the chart CSS is local.
        return [];
      }
    })
    .join('\n')
    .replace(/<\/style/giu, '<\\/style');
}

const PLUS_JAKARTA_SANS_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';

const STANDALONE_CHART_SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-bump-export-root]');
  if (!(root instanceof HTMLElement)) return;

  const dragThreshold = 5;
  let pinnedKey = root.dataset.bumpPinnedLineage || null;
  let hoveredKey = null;
  let hoverTimer = 0;
  let dragState = null;

  const lineageKey = (target) => {
    if (!(target instanceof Element)) return null;
    return (
      target.closest('[data-bump-hover-lineage]')?.getAttribute(
        'data-bump-hover-lineage',
      ) ||
      target.closest('[data-bump-lineage]')?.getAttribute('data-bump-lineage') ||
      null
    );
  };

  const renderMovementBadges = (focusedKey) => {
    root
      .querySelectorAll('.bump-chart-movement-badge')
      .forEach((badge) => badge.remove());
    if (!focusedKey) return;
    const svg = root.querySelector('.bump-chart-svg:not(.bump-chart-bridge-svg)');
    if (!(svg instanceof SVGElement)) return;
    const namespace = 'http://www.w3.org/2000/svg';
    root.querySelectorAll('.bump-chart-connection').forEach((connection) => {
      if (connection.getAttribute('data-bump-lineage') !== focusedKey) return;
      const movementValue = connection.getAttribute('data-bump-movement');
      const xValue = connection.getAttribute('data-bump-badge-x');
      const yValue = connection.getAttribute('data-bump-badge-y');
      if (movementValue == null || xValue == null || yValue == null) return;
      const movement = Number(movementValue);
      const x = Number(xValue);
      const y = Number(yValue);
      if (
        !Number.isFinite(movement) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return;
      }
      const label = movement > 0 ? '+' + movement : String(movement);
      const width = Math.max(28, label.length * 7 + 12);
      const tone =
        movement > 0 ? 'positive' : movement < 0 ? 'negative' : 'neutral';
      const badge = document.createElementNS(namespace, 'g');
      badge.setAttribute(
        'class',
        [
          'bump-chart-movement-badge',
          'bump-chart-movement-badge--' + tone,
          movement > 0
            ? 'tool-score-tone--high'
            : movement < 0
              ? 'tool-score-tone--low'
              : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      badge.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
      badge.setAttribute('data-bump-lineage', focusedKey);
      badge.setAttribute('aria-hidden', 'true');
      const rect = document.createElementNS(namespace, 'rect');
      rect.setAttribute('x', String(-width / 2));
      rect.setAttribute('y', '-10');
      rect.setAttribute('width', String(width));
      rect.setAttribute('height', '20');
      rect.setAttribute('rx', '10');
      const text = document.createElementNS(namespace, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.textContent = label;
      badge.append(rect, text);
      svg.append(badge);
    });
  };

  const applyFocus = () => {
    const focusedKey = hoveredKey || pinnedKey;
    root.querySelectorAll('.bump-chart-connection').forEach((element) => {
      const key = element.getAttribute('data-bump-lineage');
      element.classList.toggle('is-active', focusedKey != null && key === focusedKey);
      element.classList.toggle('is-dimmed', focusedKey != null && key !== focusedKey);
    });
    root
      .querySelectorAll(
        '.bump-chart-label-cell[data-bump-hover-lineage], ' +
          '.bump-chart-timeline-cell[data-bump-hover-lineage]',
      )
      .forEach((element) => {
        const key = element.getAttribute('data-bump-hover-lineage');
        element.classList.toggle(
          'is-dimmed',
          focusedKey != null && key !== focusedKey,
        );
      });
    root.querySelectorAll('.bump-chart-lineage-bridge').forEach((element) => {
      const key = element.getAttribute('data-bump-lineage');
      element.classList.toggle(
        'is-active',
        focusedKey != null && key === focusedKey,
      );
    });
    renderMovementBadges(focusedKey);
  };

  root.addEventListener('mouseover', (event) => {
    const key = lineageKey(event.target);
    if (!key || key === hoveredKey) return;
    window.clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => {
      hoveredKey = key;
      applyFocus();
    }, 200);
  });

  root.addEventListener('mouseout', (event) => {
    const fromKey = lineageKey(event.target);
    const toKey = lineageKey(event.relatedTarget);
    if (fromKey && fromKey === toKey) return;
    window.clearTimeout(hoverTimer);
    hoveredKey = null;
    applyFocus();
  });

  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const pinTarget = event.target.closest(
      '.bump-chart-connection, .bump-chart-node, ' +
        '.bump-chart-change-marker, .bump-chart-inferred-marker',
    );
    pinnedKey = pinTarget?.closest('[data-bump-lineage]')?.getAttribute(
      'data-bump-lineage',
    ) || null;
    hoveredKey = null;
    applyFocus();
  });

  const endDrag = (pointerId) => {
    if (!dragState || dragState.pointerId !== pointerId) return;
    const wasDragging = dragState.dragging;
    dragState = null;
    root.classList.remove('is-bump-dragging');
    try {
      root.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have been released.
    }
    if (!wasDragging) return;

    let cleanupTimer = 0;
    const suppressClick = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.removeEventListener('click', suppressClick, true);
      window.clearTimeout(cleanupTimer);
    };
    document.addEventListener('click', suppressClick, true);
    cleanupTimer = window.setTimeout(() => {
      document.removeEventListener('click', suppressClick, true);
    }, 250);
  };

  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const scroller = document.scrollingElement || document.documentElement;
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
      dragging: false,
    };
  });

  root.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (!dragState.dragging) {
      if (
        Math.abs(deltaX) < dragThreshold &&
        Math.abs(deltaY) < dragThreshold
      ) {
        return;
      }
      dragState.dragging = true;
      root.classList.add('is-bump-dragging');
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail if the pointer was already released.
      }
    }
    event.preventDefault();
    const scroller = document.scrollingElement || document.documentElement;
    scroller.scrollLeft = dragState.scrollLeft - deltaX;
    scroller.scrollTop = dragState.scrollTop - deltaY;
  });

  window.addEventListener('pointerup', (event) => endDrag(event.pointerId));
  window.addEventListener('pointercancel', (event) => endDrag(event.pointerId));
  root.addEventListener('lostpointercapture', (event) =>
    endDrag(event.pointerId),
  );

  applyFocus();

  const zoomSteps = ${JSON.stringify(BUMP_CHART_ZOOM_STEPS)};
  const defaultZoom = ${BUMP_CHART_DEFAULT_ZOOM};
  let zoom = defaultZoom;
  const controls = document.createElement('div');
  controls.className = 'bump-chart-zoom';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Chart zoom');
  const zoomButton = (path, title, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn bump-chart-zoom-step';
    button.innerHTML =
      '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
      '<path d="' + path + '"/></svg>';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  };
  const percent = document.createElement('button');
  percent.type = 'button';
  percent.className = 'bump-chart-zoom-value';
  percent.title = 'Reset zoom';
  // Steps update the label at once; the chart only relays out once clicking pauses.
  let shownZoom = zoom;
  let commitTimer = null;
  const setZoom = (next) => {
    clearTimeout(commitTimer);
    commitTimer = null;
    shownZoom = next;
    const scroller = document.scrollingElement || document.documentElement;
    // keep the viewport's centre point fixed while the chart scales
    const centerX = (scroller.scrollLeft + window.innerWidth / 2) / (zoom / 100);
    const centerY = (scroller.scrollTop + window.innerHeight / 2) / (zoom / 100);
    zoom = next;
    root.style.zoom = String(zoom / 100);
    percent.textContent = zoom + '%';
    scroller.scrollLeft = centerX * (zoom / 100) - window.innerWidth / 2;
    scroller.scrollTop = centerY * (zoom / 100) - window.innerHeight / 2;
  };
  const step = (direction) => {
    const next =
      direction > 0
        ? zoomSteps.find((value) => value > shownZoom)
        : [...zoomSteps].reverse().find((value) => value < shownZoom);
    if (next == null) return;
    shownZoom = next;
    percent.textContent = next + '%';
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => setZoom(next), ${BUMP_CHART_ZOOM_DEBOUNCE_MS});
  };
  percent.addEventListener('click', () => setZoom(defaultZoom));
  controls.append(
    zoomButton('${BUMP_CHART_ZOOM_OUT_PATH}', 'Zoom out', () => step(-1)),
    percent,
    zoomButton('${BUMP_CHART_ZOOM_IN_PATH}', 'Zoom in', () => step(1)),
  );
  document.body.append(controls);
  percent.textContent = zoom + '%';
})();
`;

// The SVG paths are baked at export-time coordinates, so anything that can
// reflow in another browser (text wrapping, fonts, min font size) must be frozen.
function pinExportGeometry(node: HTMLElement, clone: HTMLElement): void {
  const pinned = [
    { selector: '.bump-chart-order-name-row, .bump-chart-row', axis: 'height' },
    { selector: '[data-bump-event]', axis: 'width' },
  ] as const;
  for (const { selector, axis } of pinned) {
    const sources = node.querySelectorAll<HTMLElement>(selector);
    const targets = clone.querySelectorAll<HTMLElement>(selector);
    sources.forEach((source, index) => {
      const target = targets[index];
      if (!target) return;
      const size = `${source.getBoundingClientRect()[axis]}px`;
      if (axis === 'height') {
        target.style.height = size;
        target.style.minHeight = size;
        target.style.maxHeight = size;
      } else {
        target.style.width = size;
        target.style.minWidth = size;
        target.style.maxWidth = size;
      }
    });
  }
}

function escapedAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

export function createStandaloneBumpChartHtml(node: HTMLElement): string {
  const clone = node.cloneNode(true) as HTMLElement;
  const width = Math.ceil(
    Math.max(node.scrollWidth, node.getBoundingClientRect().width),
  );
  clone.dataset.bumpExportRoot = 'true';
  clone.style.width = `${width}px`;
  clone.style.minWidth = `${width}px`;
  clone.style.margin = '0';
  pinExportGeometry(node, clone);
  clone.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    image.setAttribute('src', image.src);
  });
  clone.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    link.setAttribute('href', link.href);
  });

  const theme = document.documentElement.dataset.theme ?? 'light';
  const styles = readableStylesheets();
  return `<!doctype html>
<html lang="en" data-theme="${escapedAttribute(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bump Chart</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${PLUS_JAKARTA_SANS_STYLESHEET}">
<style>
${styles}
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
body { padding: 16px; box-sizing: border-box; overflow: auto; }
.bump-chart-grid { margin: 0; cursor: grab; }
.bump-chart-grid.is-bump-dragging,
.bump-chart-grid.is-bump-dragging * { cursor: grabbing !important; user-select: none !important; }
.bump-chart-rank { cursor: default; }
.bump-chart-lineage-bridge { opacity: 0; }
.bump-chart-lineage-bridge.is-active { opacity: 0.85; }
.bump-chart-movement-badge.is-hidden { display: none; }.bump-chart-zoom { position: fixed; left: 16px; bottom: 16px; }
</style>
</head>
<body>
${clone.outerHTML}
<script>${STANDALONE_CHART_SCRIPT.replace(/<\/script/giu, '<\\/script')}</script>
</body>
</html>`;
}

export function exportStandaloneBumpChartHtml(node: HTMLElement): void {
  const html = createStandaloneBumpChartHtml(node);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = 'bump-chart.html';
  link.click();
  URL.revokeObjectURL(downloadUrl);
}
