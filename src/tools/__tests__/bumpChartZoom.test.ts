import { describe, expect, it } from 'vitest';
import {
  stepBumpChartZoom,
  unscaleBumpChartForExport,
} from '../panels/bumpChartZoom';

describe('stepBumpChartZoom', () => {
  it('moves to the neighbouring preset and stops at either end', () => {
    expect(stepBumpChartZoom(100, -1)).toBe(90);
    expect(stepBumpChartZoom(100, 1)).toBe(110);
    expect(stepBumpChartZoom(25, -1)).toBe(25);
    expect(stepBumpChartZoom(200, 1)).toBe(200);
  });
});

describe('unscaleBumpChartForExport', () => {
  it('removes the zoom transform until restored', () => {
    const scaler = document.createElement('div');
    scaler.className = 'bump-chart-zoom-scaler';
    scaler.style.transform = 'scale(0.5)';
    const chart = document.createElement('div');
    scaler.append(chart);

    const restore = unscaleBumpChartForExport(chart);
    expect(scaler.style.transform).toBe('');
    restore();
    expect(scaler.style.transform).toBe('scale(0.5)');
  });

  it('is a no-op at 100%', () => {
    const scaler = document.createElement('div');
    scaler.className = 'bump-chart-zoom-scaler';
    const chart = document.createElement('div');
    scaler.append(chart);

    unscaleBumpChartForExport(chart)();
    expect(scaler.style.transform).toBe('');
  });
});
