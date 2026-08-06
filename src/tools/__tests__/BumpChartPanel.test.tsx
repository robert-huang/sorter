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
  canvasImageFetchUrls,
  exportChartPng,
} from '../panels/BumpChartPanel';
import {
  _clearToolsPreferencesForTesting,
  saveToolsPreferences,
} from '../toolsPreferences';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  _clearToolsPreferencesForTesting();
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

function domRect(
  width: number,
  height: number,
  left = 0,
  top = 0,
): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
    toJSON: () => ({}),
  };
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
  it('places import actions in the order headings and counts in the staging headings', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });

    const cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(
        card.querySelector('.bump-chart-import-heading > .btn')?.textContent,
      ).toContain('Import ranked items');
      expect(
        card.querySelector('.bump-chart-staging-heading')?.textContent,
      ).toContain('Staging area0 staged');
    }

    await importSingle(0, 'Before item');
    expect(
      cards[0]?.querySelector('.bump-chart-staging-heading')?.textContent,
    ).toContain('Staging area1 staged');
  });

  it('remembers the last importer tab when reopened', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await act(async () => {
      button('Import ranked items').click();
    });
    await act(async () => {
      button('Results').click();
    });
    expect(button('Results').getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      button('Results').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.querySelector('.modal-backdrop')).toBeNull();

    await act(async () => {
      button('Import ranked items', 1).click();
    });
    expect(button('Results').getAttribute('aria-selected')).toBe('true');
  });

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

  it('shows a signed movement badge only while a matched line is hovered', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    for (const label of ['A', 'B', 'C']) {
      await importSingle(0, label);
    }
    for (const label of ['B', 'A', 'C']) {
      await importSingle(1, label);
    }
    await act(async () => {
      button('Generate chart').click();
    });

    const hitPaths = container.querySelectorAll<SVGPathElement>(
      '.bump-chart-path-hit',
    );
    expect(hitPaths).toHaveLength(3);
    expect(container.querySelector('.bump-chart-movement-badge')).toBeNull();

    await act(async () => {
      hitPaths[0]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const negativeBadge = container.querySelector<SVGGElement>(
      '.bump-chart-movement-badge',
    );
    expect(negativeBadge?.textContent).toBe('-1');
    expect(negativeBadge?.classList.contains('tool-score-tone--low')).toBe(true);
    expect(negativeBadge?.dataset.pngExclude).toBe('true');

    await act(async () => {
      hitPaths[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const positiveBadge = container.querySelector<SVGGElement>(
      '.bump-chart-movement-badge',
    );
    expect(positiveBadge?.textContent).toBe('+1');
    expect(positiveBadge?.classList.contains('tool-score-tone--high')).toBe(
      true,
    );

    await act(async () => {
      hitPaths[2]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const neutralBadge = container.querySelector<SVGGElement>(
      '.bump-chart-movement-badge',
    );
    expect(neutralBadge?.textContent).toBe('0');
    expect(neutralBadge?.classList.contains('tool-score-tone--high')).toBe(
      false,
    );
    expect(neutralBadge?.classList.contains('tool-score-tone--low')).toBe(
      false,
    );
    const connectionGroups = container.querySelectorAll(
      '.bump-chart-connection',
    );
    expect(neutralBadge?.previousElementSibling).toBe(
      connectionGroups[connectionGroups.length - 1],
    );

    await act(async () => {
      hitPaths[2]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('.bump-chart-movement-badge')).toBeNull();
  });

  it('marks title-inferred lines and keeps a clicked lineage pinned', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    for (const label of ['A', 'B']) {
      await importSingle(0, label);
    }
    for (const label of ['B', 'A']) {
      await importSingle(1, label);
    }
    await act(async () => {
      button('Generate chart').click();
    });

    expect(
      container.querySelectorAll(
        '[aria-label="Inferred match from an exact label"]',
      ).length,
    ).toBe(2);
    const inferredMarkers = container.querySelectorAll<SVGGElement>(
      '.bump-chart-inferred-marker',
    );
    expect(inferredMarkers[0]?.dataset.pathPosition).toBe('0.9');
    expect(
      inferredMarkers[0]?.querySelector('.bump-chart-inferred-icon'),
    ).not.toBeNull();
    expect(inferredMarkers[0]?.querySelector('text')).toBeNull();
    const connections = container.querySelectorAll<SVGGElement>(
      '.bump-chart-connection',
    );
    const hitPaths = container.querySelectorAll<SVGPathElement>(
      '.bump-chart-path-hit',
    );

    await act(async () => {
      hitPaths[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      hitPaths[0]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(connections[0]?.classList.contains('is-active')).toBe(true);
    expect(connections[1]?.classList.contains('is-dimmed')).toBe(true);
    expect(container.querySelector('.bump-chart-movement-badge')).not.toBeNull();

    await act(async () => {
      hitPaths[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(connections[0]?.classList.contains('is-active')).toBe(true);
    expect(connections[1]?.classList.contains('is-active')).toBe(false);

    const secondLineageLabel = container.querySelector<HTMLElement>(
      '.bump-chart-item-link[data-bump-lineage="matched:1:0"]',
    );
    await act(async () => {
      secondLineageLabel?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(connections[0]?.classList.contains('is-active')).toBe(false);
    expect(connections[1]?.classList.contains('is-active')).toBe(true);

    await act(async () => {
      hitPaths[1]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('.bump-chart-connection.is-active'),
    ).toBeNull();
    expect(
      container.querySelector('.bump-chart-connection.is-dimmed'),
    ).toBeNull();
  });

  it('reacts to Best Match by Title changes for an existing chart', async () => {
    saveToolsPreferences({ bumpChartBestMatchByTitle: false });
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Same title');
    await importSingle(1, 'Same title');
    await act(async () => {
      button('Generate chart').click();
    });

    expect(container.querySelectorAll('.bump-chart-connection')).toHaveLength(2);
    expect(container.querySelector('.bump-chart-inferred-marker')).toBeNull();

    await act(async () => {
      saveToolsPreferences({ bumpChartBestMatchByTitle: true });
    });
    expect(container.querySelectorAll('.bump-chart-connection')).toHaveLength(1);
    expect(container.querySelector('.bump-chart-inferred-marker')).not.toBeNull();
  });

  it('shrinks the SVG after zoom without retaining its old scroll height', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Before');
    await importSingle(1, 'After');
    await act(async () => {
      button('Generate chart').click();
    });

    const grid = container.querySelector<HTMLElement>('.bump-chart-grid');
    const row = container.querySelector<HTMLElement>('.bump-chart-row');
    const center = container.querySelector<HTMLElement>(
      '.bump-chart-center-cell',
    );
    if (!grid || !row || !center) {
      throw new Error('Bump Chart geometry was not rendered');
    }
    let gridHeight = 240;
    vi.spyOn(grid, 'getBoundingClientRect').mockImplementation(() =>
      domRect(1_000, gridHeight),
    );
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(domRect(1_000, 64));
    vi.spyOn(center, 'getBoundingClientRect').mockReturnValue(
      domRect(280, 64, 360),
    );
    Object.defineProperty(grid, 'scrollHeight', {
      configurable: true,
      value: 600,
    });

    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(
      container.querySelector<SVGSVGElement>('.bump-chart-svg')?.style.height,
    ).toBe('240px');

    gridHeight = 120;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(
      container.querySelector<SVGSVGElement>('.bump-chart-svg')?.style.height,
    ).toBe('120px');
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

  it('exports AniList images through the CORS proxy and skips inaccessible images', async () => {
    const anilistImage =
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg';
    const proxiedAnilistImage = canvasImageFetchUrls(
      anilistImage,
      '',
      true,
    )[1];
    if (!proxiedAnilistImage) {
      throw new Error('AniList image proxy is not configured for this test');
    }
    const chart = document.createElement('div');
    chart.style.backgroundColor = 'rgb(255, 255, 255)';
    chart.innerHTML =
      '<a class="bump-chart-item-link"><img src="https://example.invalid/cover.jpg"></a>' +
      `<a class="bump-chart-item-link"><img src="${anilistImage}"></a>` +
      '<span class="bump-chart-label">A<span>B</span></span>' +
      '<svg><g class="bump-chart-movement-badge" data-png-exclude="true">' +
      '<text>+2</text></g></svg>';
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === proxiedAnilistImage) {
        return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          status: 200,
        });
      }
      throw new Error('blocked');
    });
    vi.stubGlobal('fetch', fetchMock);
    class FakeImageBitmap {
      readonly width = 100;
      readonly height = 150;
      readonly close = vi.fn();
    }
    const bitmap = new FakeImageBitmap();
    vi.stubGlobal('ImageBitmap', FakeImageBitmap);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const imageElements = chart.querySelectorAll('img');
    imageElements.forEach((image, index) => {
      vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
        x: index * 50,
        y: 10,
        top: 10,
        right: index * 50 + 38,
        bottom: 58,
        left: index * 50,
        width: 38,
        height: 48,
        toJSON: () => ({}),
      });
    });

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

    expect(fetchMock).toHaveBeenCalledWith(anilistImage, { mode: 'cors' });
    expect(fetchMock).toHaveBeenCalledWith(
      proxiedAnilistImage,
      { mode: 'cors' },
    );
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(context.fillText).toHaveBeenCalledWith('AB', 0, 0);
    expect(context.fillText).not.toHaveBeenCalledWith(
      '+2',
      expect.any(Number),
      expect.any(Number),
    );
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

describe('canvasImageFetchUrls', () => {
  it('adds the configured worker fallback only for AniList CDN images', () => {
    const source =
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg';
    expect(
      canvasImageFetchUrls(source, 'https://proxy.example/root/', true),
    ).toEqual([
      source,
      'https://proxy.example/root/image?path=%2Ffile%2Fanilistcdn%2Fmedia%2Fanime%2Fcover%2Flarge%2Ftest.jpg',
      '/api/anilist-image/file/anilistcdn/media/anime/cover/large/test.jpg',
    ]);
    expect(
      canvasImageFetchUrls(
        'https://images.example/cover.jpg',
        'https://proxy.example',
        true,
      ),
    ).toEqual(['https://images.example/cover.jpg']);
  });
});
