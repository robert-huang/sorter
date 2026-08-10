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

const STANDALONE_CHART_SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-bump-export-root]');
  if (!(root instanceof HTMLElement)) return;

  let pinnedKey = root.dataset.bumpPinnedLineage || null;
  let hoveredKey = null;
  let hoverTimer = 0;

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
    root.querySelectorAll('.bump-chart-movement-badge').forEach((element) => {
      const key = element.getAttribute('data-bump-lineage');
      element.classList.toggle('is-hidden', key != null && key !== focusedKey);
    });
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

  applyFocus();
})();
`;

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
<style>
${styles}
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
body { padding: 16px; box-sizing: border-box; overflow: auto; }
.bump-chart-grid { margin: 0; }
.bump-chart-rank { cursor: default; }
.bump-chart-lineage-bridge { opacity: 0; }
.bump-chart-lineage-bridge.is-active { opacity: 0.85; }
.bump-chart-movement-badge.is-hidden { display: none; }
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
