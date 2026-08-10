import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStandaloneBumpChartHtml,
  exportStandaloneBumpChartHtml,
} from '../panels/bumpChartHtmlExport';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.head.querySelector('[data-test-chart-style]')?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function chartFixture(): HTMLDivElement {
  const chart = document.createElement('div');
  chart.className = 'bump-chart-grid';
  chart.dataset.bumpPinnedLineage = 'lineage-A';
  chart.innerHTML = `
    <div
      class="bump-chart-label-cell is-dimmed"
      data-bump-hover-lineage="lineage-B"
    >B</div>
    <svg class="bump-chart-svg">
      <g
        class="bump-chart-connection is-active"
        data-bump-lineage="lineage-A"
        data-bump-movement="2"
        data-bump-badge-x="5"
        data-bump-badge-y="5"
      >
        <path class="bump-chart-path" d="M 0 0 L 10 10"></path>
      </g>
      <g
        class="bump-chart-connection is-dimmed"
        data-bump-lineage="lineage-B"
        data-bump-movement="-1"
        data-bump-badge-x="6"
        data-bump-badge-y="6"
      >
        <path class="bump-chart-path" d="M 0 10 L 10 0"></path>
      </g>
    </svg>
    <svg class="bump-chart-svg bump-chart-bridge-svg">
      <path
        class="bump-chart-lineage-bridge is-active"
        data-bump-lineage="lineage-A"
        d="M 10 10 L 20 20"
      ></path>
    </svg>
  `;
  Object.defineProperty(chart, 'scrollWidth', {
    configurable: true,
    value: 2_400,
  });
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 1_000,
    bottom: 600,
    left: 0,
    width: 1_000,
    height: 600,
    toJSON: () => ({}),
  });
  return chart;
}

function dispatchPointer(
  type: string,
  target: EventTarget,
  clientX: number,
  clientY: number,
  pointerId = 1,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
  });
  target.dispatchEvent(event);
}

describe('standalone Bump Chart HTML export', () => {
  it('preserves the pinned lineage and embeds interactive hover controls', () => {
    document.documentElement.dataset.theme = 'dark';
    const style = document.createElement('style');
    style.dataset.testChartStyle = 'true';
    style.textContent = '.bump-chart-grid { background: rebeccapurple; }';
    document.head.appendChild(style);

    const html = createStandaloneBumpChartHtml(chartFixture());

    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('data-bump-pinned-lineage="lineage-A"');
    expect(html).toContain('data-bump-export-root="true"');
    expect(html).toContain('width: 2400px');
    expect(html).toContain('background: rebeccapurple');
    expect(html).toContain(
      'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans',
    );
    expect(html).toContain("let pinnedKey = root.dataset.bumpPinnedLineage");
    expect(html).toContain("root.addEventListener('mouseover'");
    expect(html).toContain("root.addEventListener('click'");
    expect(html).toContain("root.addEventListener('pointermove'");
    expect(html).toContain(
      ".bump-chart-lineage-bridge.is-active { opacity: 0.85; }",
    );
  });

  it('downloads one HTML file without a backend', () => {
    const createObjectUrl = vi.fn((_blob: Blob) => 'blob:bump-chart');
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    exportStandaloneBumpChartHtml(chartFixture());

    expect(createObjectUrl).toHaveBeenCalledOnce();
    const blob = createObjectUrl.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('text/html;charset=utf-8');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:bump-chart');
  });

  it('loads the saved highlight but still clears and changes it', () => {
    vi.useFakeTimers();
    const exported = new DOMParser().parseFromString(
      createStandaloneBumpChartHtml(chartFixture()),
      'text/html',
    );
    document.body.innerHTML = exported.body.innerHTML;
    const script = document.body.querySelector('script')?.textContent;
    if (!script) {
      throw new Error('Standalone chart script was not exported');
    }
    window.eval(script);

    const root = document.querySelector<HTMLElement>(
      '[data-bump-export-root]',
    )!;
    const connections = root.querySelectorAll('.bump-chart-connection');
    const bridge = root.querySelector('.bump-chart-lineage-bridge');
    expect(connections[0]?.classList.contains('is-active')).toBe(true);
    expect(connections[1]?.classList.contains('is-dimmed')).toBe(true);
    expect(bridge?.classList.contains('is-active')).toBe(true);
    expect(
      root.querySelector('.bump-chart-movement-badge')?.textContent,
    ).toBe('+2');

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(connections[0]?.classList.contains('is-active')).toBe(false);
    expect(connections[1]?.classList.contains('is-dimmed')).toBe(false);
    expect(bridge?.classList.contains('is-active')).toBe(false);
    expect(root.querySelector('.bump-chart-movement-badge')).toBeNull();

    const label = root.querySelector<HTMLElement>(
      '[data-bump-hover-lineage="lineage-B"]',
    )!;
    label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(connections[0]?.classList.contains('is-dimmed')).toBe(true);
    expect(connections[1]?.classList.contains('is-active')).toBe(true);
    expect(
      root.querySelector('.bump-chart-movement-badge')?.textContent,
    ).toBe('-1');
  });

  it('drag-pans the page without treating the gesture as a click', () => {
    vi.useFakeTimers();
    const exported = new DOMParser().parseFromString(
      createStandaloneBumpChartHtml(chartFixture()),
      'text/html',
    );
    document.body.innerHTML = exported.body.innerHTML;
    const script = document.body.querySelector('script')?.textContent;
    if (!script) {
      throw new Error('Standalone chart script was not exported');
    }
    const root = document.querySelector<HTMLElement>(
      '[data-bump-export-root]',
    )!;
    root.setPointerCapture = vi.fn();
    root.releasePointerCapture = vi.fn();
    document.documentElement.scrollLeft = 100;
    document.documentElement.scrollTop = 50;
    window.eval(script);

    dispatchPointer('pointerdown', root, 100, 100);
    dispatchPointer('pointermove', root, 60, 80);

    expect(document.documentElement.scrollLeft).toBe(140);
    expect(document.documentElement.scrollTop).toBe(70);
    expect(root.classList.contains('is-bump-dragging')).toBe(true);

    dispatchPointer('pointerup', window, 60, 80);
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.classList.contains('is-bump-dragging')).toBe(false);
    expect(
      root
        .querySelector('.bump-chart-connection')
        ?.classList.contains('is-active'),
    ).toBe(true);
  });
});
