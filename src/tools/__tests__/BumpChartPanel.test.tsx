import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  BumpChartPanel,
  exportChartPng,
} from '../panels/BumpChartPanel';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string, index = 0): HTMLButtonElement {
  const matches = Array.from(document.querySelectorAll('button')).filter(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const match = matches[index];
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label} at index ${index}`);
  }
  return match;
}

async function importSingle(sideIndex: number, label: string): Promise<void> {
  await act(async () => {
    button('Import ranked items', sideIndex).click();
  });
  expect(
    Array.from(document.querySelectorAll('[role="tab"]')).map((tab) =>
      tab.textContent?.trim(),
    ),
  ).toEqual(['Single', 'Multiple', 'AniList', 'Results']);
  const input = document.querySelector<HTMLInputElement>('#add-label');
  if (!input) {
    throw new Error('Single item label input was not rendered');
  }
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(input, label);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    button('Add').click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BumpChartPanel staging flow', () => {
  it('stages both sides and renders only after Generate chart', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('.bump-chart-grid')).toBeNull();
    await importSingle(0, 'Before item');
    await importSingle(1, 'After item');
    expect(container.textContent).toContain('1 staged');
    expect(container.querySelector('.bump-chart-grid')).toBeNull();

    await act(async () => {
      button('Generate chart').click();
    });
    expect(container.querySelector('.bump-chart-grid')).not.toBeNull();
    expect(container.querySelectorAll('.bump-chart-rank')).toHaveLength(2);
    expect(container.textContent).toContain('Clear chart');
    expect(container.textContent).toContain('Export PNG');
    expect(container.textContent).not.toContain('staged');

    await act(async () => {
      button('Clear chart').click();
    });
    expect(container.querySelector('.bump-chart-grid')).toBeNull();
    expect(container.textContent).toContain('No ranked lists staged yet.');
  });

  it('opens the sorter edit modal from a generated rank number', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Left');
    await importSingle(1, 'Right');
    await act(async () => {
      button('Generate chart').click();
    });
    await act(async () => {
      button('#1', 0).click();
    });
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(document.body.textContent).toContain('Edit item');
  });

  it('uses sorter staging groups and exposes duplicate rows that will be skipped', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Duplicate');
    await importSingle(0, 'Duplicate');

    expect(container.textContent).toContain(
      '1 duplicate entry across sources',
    );
    const groups = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.bump-chart-import-card:first-of-type .staged-panel-group-row',
      ),
    );
    expect(groups).toHaveLength(2);
    await act(async () => {
      groups.forEach((group) => group.click());
    });
    expect(container.textContent).toContain('duplicate — will be skipped');
  });

  it('soft-removes staged groups and allows restoring them', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Restore me');
    const remove = container.querySelector<HTMLButtonElement>(
      '.bump-chart-import-card:first-of-type .staged-panel-group-remove',
    );
    expect(remove).not.toBeNull();

    await act(async () => {
      remove?.click();
    });
    expect(container.textContent).toContain('1 marked for removal');
    const undo = container.querySelector<HTMLButtonElement>(
      '.bump-chart-import-card:first-of-type .staged-panel-group-undo',
    );
    expect(undo).not.toBeNull();

    await act(async () => {
      undo?.click();
    });
    expect(container.textContent).not.toContain('marked for removal');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.bump-chart-import-card:first-of-type .staged-panel-group-row',
        )
        ?.click();
    });
    expect(container.textContent).toContain('Restore me');
  });

  it('restores individually removed items and excludes marked items on generation', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Keep');
    await importSingle(0, 'Remove me');
    const leftGroups = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.bump-chart-import-card:first-of-type .staged-panel-group-row',
      ),
    );
    await act(async () => {
      leftGroups[1]?.click();
    });
    const removeItem = container.querySelector<HTMLButtonElement>(
      '.bump-chart-import-card:first-of-type .staged-panel-item-remove',
    );
    expect(removeItem).not.toBeNull();

    await act(async () => {
      removeItem?.click();
    });
    const undoItem = container.querySelector<HTMLButtonElement>(
      '.bump-chart-import-card:first-of-type .staged-panel-item-undo',
    );
    expect(undoItem).not.toBeNull();
    await act(async () => {
      undoItem?.click();
    });
    expect(
      container.querySelector(
        '.bump-chart-import-card:first-of-type .staged-panel-item-undo',
      ),
    ).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '.bump-chart-import-card:first-of-type .staged-panel-item-remove',
        )
        ?.click();
    });
    await importSingle(1, 'Keep');
    await act(async () => {
      button('Generate chart').click();
    });
    expect(container.querySelector('.bump-chart-grid')).not.toBeNull();
    expect(container.querySelector('.bump-chart-grid')?.textContent).not.toContain(
      'Remove me',
    );
  });

  it('exports without drawing inaccessible remote images onto the canvas', async () => {
    const chart = document.createElement('div');
    chart.style.backgroundColor = 'rgb(255, 255, 255)';
    chart.innerHTML =
      '<a class="bump-chart-item-link"><img src="https://example.invalid/cover.jpg"></a>' +
      '<span class="bump-chart-label">A<span>B</span></span>';
    document.body.appendChild(chart);
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 300,
      bottom: 200,
      left: 0,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('blocked')));

    const context = {
      scale: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      drawImage: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textBaseline: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => callback(new Blob(['png'])));
    const createObjectUrl = vi.fn(() => 'blob:chart');
    const revokeObjectUrl = vi.fn();
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      'createObjectURL',
    );
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
      URL,
      'revokeObjectURL',
    );
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.spyOn(document, 'createRange').mockImplementation(
      () =>
        ({
          setStart: (node: Node, offset: number) => {
            if (!(node instanceof Text) || offset > node.data.length) {
              throw new DOMException('Invalid range start');
            }
          },
          setEnd: (node: Node, offset: number) => {
            if (!(node instanceof Text) || offset > node.data.length) {
              throw new DOMException('Invalid range end');
            }
          },
          getBoundingClientRect: () => ({
            x: 0,
            y: 0,
            top: 0,
            right: 8,
            bottom: 16,
            left: 0,
            width: 8,
            height: 16,
            toJSON: () => ({}),
          }),
        }) as unknown as Range,
    );

    await exportChartPng(chart);

    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledWith('AB', 0, 0);
    expect(toBlob).toHaveBeenCalledOnce();
    expect(createObjectUrl).toHaveBeenCalledOnce();
    if (createObjectUrlDescriptor) {
      Object.defineProperty(
        URL,
        'createObjectURL',
        createObjectUrlDescriptor,
      );
    } else {
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
    }
    if (revokeObjectUrlDescriptor) {
      Object.defineProperty(
        URL,
        'revokeObjectURL',
        revokeObjectUrlDescriptor,
      );
    } else {
      delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    }
    chart.remove();
  });
});
