export const BUMP_CHART_ZOOM_STEPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200,
] as const;

export const BUMP_CHART_DEFAULT_ZOOM = 100;

/** Quiet time after the last +/− click before the chart re-renders at the new zoom. */
export const BUMP_CHART_ZOOM_DEBOUNCE_MS = 250;

// Drawn as SVG because font glyphs for − and + sit below a button's centre.
export const BUMP_CHART_ZOOM_OUT_PATH = 'M2 6H10';
export const BUMP_CHART_ZOOM_IN_PATH = 'M2 6H10M6 2V10';

/** Next preset zoom percentage in `direction`, or the current one at either end. */
export function stepBumpChartZoom(zoom: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? BUMP_CHART_ZOOM_STEPS.find((value) => value > zoom)
      : [...BUMP_CHART_ZOOM_STEPS].reverse().find((value) => value < zoom);
  return next ?? zoom;
}

/**
 * The in-app chart scales a wrapper with a CSS transform; exports measure the
 * DOM with getBoundingClientRect, so they must run against the unscaled chart.
 */
export function unscaleBumpChartForExport(node: HTMLElement): () => void {
  const scaler = node.closest<HTMLElement>('.bump-chart-zoom-scaler');
  if (!scaler || !scaler.style.transform) {
    return () => {};
  }
  const transform = scaler.style.transform;
  scaler.style.transform = '';
  return () => {
    scaler.style.transform = transform;
  };
}
