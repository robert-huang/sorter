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
  applyBumpChartItemEdit,
  bumpChartExportCanvasLayout,
  bumpTimelineColumnAnchorX,
  bumpTimelinePathEndpoints,
  bumpTimelinePathMidpoint,
  exportChartPng,
  inferredMatchMarkerPosition,
} from '../panels/BumpChartPanel';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
  saveToolsPreferences,
} from '../toolsPreferences';
import {
  STATE_REVISION_KEY,
  _resetStateStorageForTesting,
} from '../../lib/stateStorageDb';
import {
  _resetBumpChartStorageCacheForTesting,
  flushBumpChartStorageWrites,
  saveActiveBumpChartWorkspace,
  type BumpChartColumnSnapshot,
} from '../panels/bumpChartStorage';
import { _resetBumpChartImageMemoryCacheForTesting } from '../panels/bumpChartImageCache';
import { _resetBumpMalExportImagesForTesting } from '../panels/bumpChartMalExportImages';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(async () => {
  await flushBumpChartStorageWrites();
  localStorage.clear();
  await _resetStateStorageForTesting();
  _resetBumpChartStorageCacheForTesting();
  _resetBumpChartImageMemoryCacheForTesting();
  _resetBumpMalExportImagesForTesting();
  _clearToolsPreferencesForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  await flushBumpChartStorageWrites();
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

function emptyWorkspaceColumn(
  id: string,
  kind: 'previous' | 'current',
): BumpChartColumnSnapshot {
  return {
    id,
    kind,
    items: [],
    hiddenItemIds: [],
    preserveCustomLabels: false,
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
  it('hydrates a canonical id and keeps the Bump logical id synchronized', () => {
    const hydrated = {
      id: 'anilist:123',
      label: 'Cached title',
      url: 'https://anilist.co/anime/123',
      imageUrl: 'https://example.com/123.jpg',
      source: { kind: 'anilist' as const, externalId: 123 },
      searchTokens: ['Cached title', 'English title'],
    };

    expect(
      applyBumpChartItemEdit(
        {
          item: { id: 'manual', label: 'Manual title' },
          logicalId: 'manual',
        },
        {
          id: hydrated.id,
          hydratedItem: hydrated,
          label: 'Explicit title',
        },
      ),
    ).toEqual({
      item: {
        ...hydrated,
        label: 'Explicit title',
        anilistLabelMode: 'custom',
      },
      logicalId: hydrated.id,
    });
  });

  it('places import actions in the order headings and counts in the staging headings', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
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
    const summary = cards[0]?.querySelector('.staged-panel-summary');
    expect(summary?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 unique item ready across 1 source',
    );
    expect(summary?.querySelector('.staged-panel-marked-count')).toBeNull();
    expect(summary?.querySelector('.staged-panel-marked-line')).toBeNull();
    expect(summary?.textContent).not.toContain('pre-ranked sublist');
    expect(summary?.textContent).not.toContain('marked for removal');

    await act(async () => {
      cards[0]
        ?.querySelector<HTMLButtonElement>('[aria-label="Hide Single item"]')
        ?.click();
    });
    expect(summary?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '0 unique items ready across 1 source · 1 hidden',
    );
    expect(
      cards[0]?.querySelector('[aria-label="Unhide Single item"]'),
    ).not.toBeNull();
    expect(
      cards[0]?.querySelector<HTMLButtonElement>(
        '[title="Remove every staged group"]',
      )?.textContent,
    ).toBe('Clear');
  });

  it('promotes the current order, reorders and removes it, and clears columns', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    const generateRow = container.querySelector('.bump-chart-generate-row');
    expect(
      Array.from(generateRow?.querySelectorAll('button') ?? []).map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual(['Clear all staged', 'Generate chart']);

    await importSingle(1, 'Promoted current');
    await act(async () => {
      button('+').click();
    });
    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(3);
    let cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards[1]?.textContent).toContain('1 staged');
    expect(cards[2]?.textContent).toContain('Current order');
    expect(cards[2]?.textContent).toContain('0 staged');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Previous order 2"]',
      )?.disabled,
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Current order"]',
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Remove Current order"]',
        )
        ?.click();
    });
    cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('0 staged');
    expect(cards[1]?.textContent).toContain('Current order');
    expect(cards[1]?.textContent).toContain('1 staged');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Current order"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      button('+').click();
    });
    cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards).toHaveLength(3);
    expect(cards[1]?.textContent).toContain('1 staged');
    expect(cards[2]?.textContent).toContain('0 staged');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Move Previous order 2 up"]',
        )
        ?.click();
    });
    cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards[0]?.textContent).toContain('1 staged');
    expect(cards[1]?.textContent).toContain('0 staged');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Remove Previous order 1"]',
        )
        ?.click();
    });
    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(2);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Previous order 1"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      button('+').click();
      button('+').click();
    });
    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(4);
    await act(async () => {
      button('Clear all staged').click();
    });
    cards = container.querySelectorAll('.bump-chart-import-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Previous order');
    expect(cards[0]?.textContent).not.toContain('Previous order 1');
    expect(cards[1]?.textContent).toContain('Current order');
    expect(
      Array.from(cards).every((card) => card.textContent?.includes('0 staged')),
    ).toBe(true);
  });

  it('keeps a local add made before IndexedDB hydration completes', async () => {
    await saveActiveBumpChartWorkspace({
      version: 2,
      view: 'staging',
      columns: [
        emptyWorkspaceColumn('previous-1', 'previous'),
        emptyWorkspaceColumn('previous-2', 'previous'),
        emptyWorkspaceColumn('previous-3', 'previous'),
        emptyWorkspaceColumn('current', 'current'),
      ],
      bestMatchByTitle: true,
      lastImportTab: 'single',
    });
    await flushBumpChartStorageWrites();
    _resetBumpChartStorageCacheForTesting();

    act(() => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    act(() => {
      button('+').click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(3);
  });

  it('renders intermediate events and a pinned bridge across a lineage gap', async () => {
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
      button('+').click();
    });
    await importSingle(0, 'A');
    await importSingle(1, 'B');
    await importSingle(2, 'A');
    await act(async () => {
      button('Generate chart').click();
    });

    expect(container.querySelectorAll('.bump-chart-center-cell')).toHaveLength(2);
    const event = container.querySelector<HTMLElement>(
      '.bump-chart-event-label',
    );
    expect(event?.textContent).not.toContain('(+)-');
    expect(event?.textContent).not.toContain('-(x)');
    const eventNode = event?.querySelector('.bump-chart-event-node');
    expect(eventNode?.textContent).toContain('#1');
    expect(eventNode?.textContent).toContain('B');
    expect(
      eventNode?.querySelector('.bump-chart-rank')?.nextElementSibling,
    ).toBe(eventNode?.querySelector('.bump-chart-item-link'));
    expect(event?.getAttribute('title')).toBeNull();
    expect(
      event?.querySelector('.bump-chart-item-link')?.getAttribute('title'),
    ).toContain('B');
    expect(container.querySelectorAll('.bump-chart-node')).toHaveLength(2);

    const firstPath = container.querySelector<SVGPathElement>(
      '.bump-chart-path-hit',
    );
    await act(async () => {
      firstPath?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.bump-chart-lineage-bridge')).not.toBeNull();
    expect(
      event?.classList.contains('is-dimmed'),
    ).toBe(true);
    expect(event?.querySelector('.bump-chart-event-node')).not.toBeNull();

    await act(async () => {
      event?.querySelector<HTMLButtonElement>('.bump-chart-rank')?.click();
    });
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(event?.classList.contains('is-dimmed')).toBe(true);
  });

  it('renders one separated inferred marker for every inferred lineage segment', async () => {
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
      button('+').click();
      button('+').click();
    });
    for (let columnIndex = 0; columnIndex < 4; columnIndex += 1) {
      await importSingle(columnIndex, 'Repeated title');
    }
    await act(async () => {
      button('Generate chart').click();
    });

    const markers = container.querySelectorAll<SVGGElement>(
      '.bump-chart-inferred-marker',
    );
    const connections = container.querySelectorAll<SVGGElement>(
      '.bump-chart-connection',
    );
    expect(connections).toHaveLength(3);
    expect(markers).toHaveLength(3);
    connections.forEach((connection) => {
      const marker = connection.querySelector('.bump-chart-inferred-marker');
      const icon = marker?.querySelector('.bump-chart-inferred-icon');
      expect(marker?.querySelector('title')?.textContent).toBe(
        'Inferred match from an exact label',
      );
      expect(icon?.querySelectorAll('circle')).toHaveLength(1);
      expect(icon?.querySelectorAll('line')).toHaveLength(2);
    });
    expect(
      new Set(
        Array.from(markers, (marker) =>
          marker.closest('.bump-chart-connection'),
        ),
      ).size,
    ).toBe(3);
    expect(
      new Set(
        Array.from(
          connections,
          (connection) => connection.dataset.bumpLineage,
        ),
      ).size,
    ).toBe(1);
    expect(container.querySelectorAll('.bump-chart-node')).toHaveLength(2);
  });

  it('opens intermediate media labels without pinning their lineage', async () => {
    await saveActiveBumpChartWorkspace({
      version: 2,
      view: 'chart',
      columns: [
        emptyWorkspaceColumn('previous-1', 'previous'),
        {
          id: 'previous-2',
          kind: 'previous',
          items: [
            {
              item: {
                id: 'anilist:1',
                label: 'Intermediate media',
                imageUrl: 'https://example.invalid/cover.jpg',
                url: 'https://anilist.co/anime/1',
                source: { kind: 'anilist', externalId: 1 },
              },
              logicalId: 'AAAAAAAAAAAAAA',
            },
          ],
          hiddenItemIds: [],
          preserveCustomLabels: false,
        },
        emptyWorkspaceColumn('current', 'current'),
      ],
      bestMatchByTitle: true,
      lastImportTab: 'single',
    });
    const onOpenMedia = vi.fn();
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={onOpenMedia}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const eventNode = container.querySelector<HTMLElement>(
      '.bump-chart-event-node',
    );
    await act(async () => {
      eventNode?.querySelector<HTMLElement>('.bump-chart-label')?.click();
      eventNode?.querySelector<HTMLImageElement>('img')?.click();
    });
    expect(onOpenMedia).toHaveBeenCalledTimes(2);
    expect(onOpenMedia).toHaveBeenCalledWith(1, 'Intermediate media');
    expect(container.querySelector('.bump-chart-connection.is-active')).toBeNull();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
  });

  it('pins a lineage when its added or removed marker icon is clicked', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Removed item');
    await importSingle(1, 'Added item');
    await act(async () => {
      button('Generate chart').click();
    });

    const removedMarker = container.querySelector<SVGGElement>(
      '.bump-chart-change-marker--removed',
    );
    const addedMarker = container.querySelector<SVGGElement>(
      '.bump-chart-change-marker--added',
    );
    await act(async () => {
      removedMarker
        ?.querySelector('line')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      removedMarker
        ?.closest('.bump-chart-connection')
        ?.classList.contains('is-active'),
    ).toBe(true);

    await act(async () => {
      addedMarker
        ?.querySelector('line')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      addedMarker
        ?.closest('.bump-chart-connection')
        ?.classList.contains('is-active'),
    ).toBe(true);
  });

  it('opens the item editor from a continuing intermediate rank node', async () => {
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
      button('+').click();
    });
    await importSingle(0, 'Continuous');
    await importSingle(1, 'Continuous');
    await importSingle(2, 'Continuous');
    await act(async () => {
      button('Generate chart').click();
    });

    const compactNode = container.querySelector<HTMLElement>(
      '.bump-chart-compact-node',
    );
    expect(compactNode?.dataset.label).toBe('Continuous');
    await act(async () => {
      compactNode?.click();
    });
    expect(document.querySelector('.modal-backdrop')).not.toBeNull();
    expect(container.querySelector('.bump-chart-connection.is-active')).toBeNull();
  });

  it('live-updates timeline matching after editing a logical id', async () => {
    await saveActiveBumpChartWorkspace({
      version: 2,
      view: 'chart',
      columns: [
        {
          id: 'previous-1',
          kind: 'previous',
          items: [
            {
              item: { id: 'AAAAAAAAAAAAAA', label: 'Before label' },
              logicalId: 'AAAAAAAAAAAAAA',
            },
          ],
          hiddenItemIds: [],
          preserveCustomLabels: false,
        },
        {
          id: 'current',
          kind: 'current',
          items: [
            {
              item: { id: 'BBBBBBBBBBBBBB', label: 'After label' },
              logicalId: 'AAAAAAAAAAAAAA',
            },
          ],
          hiddenItemIds: [],
          preserveCustomLabels: false,
        },
      ],
      bestMatchByTitle: true,
      lastImportTab: 'single',
    });
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.bump-chart-connection')).toHaveLength(1);
    expect(container.querySelectorAll('.bump-chart-change-marker')).toHaveLength(
      0,
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Edit rank 1: Before label"]',
        )
        ?.click();
    });
    await act(async () => {
      button('Show advanced').click();
    });
    const logicalIdInput = document.querySelector<HTMLInputElement>(
      '.edit-item-advanced input',
    );
    if (!logicalIdInput) {
      throw new Error('Logical ID input was not rendered');
    }
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(logicalIdInput, 'QQQQQQQQQQQQQQ');
      logicalIdInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Save').click();
    });

    expect(container.querySelectorAll('.bump-chart-connection')).toHaveLength(2);
    expect(container.querySelectorAll('.bump-chart-change-marker')).toHaveLength(
      2,
    );
  });

  it('keeps an expanded staged sublist open after an equivalent cross-tab refresh', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await importSingle(0, 'Before item');

    const stagedRow = container.querySelector<HTMLButtonElement>(
      '.staged-panel-group-row',
    );
    expect(stagedRow).not.toBeNull();
    await act(async () => {
      stagedRow?.click();
    });
    expect(stagedRow?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await flushBumpChartStorageWrites();
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STATE_REVISION_KEY,
          newValue: JSON.stringify({
            scope: 'bump',
            id: 'active',
            source: 'another-tab',
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      container
        .querySelector<HTMLButtonElement>('.staged-panel-group-row')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('does not revert a local add or remove from another tab active snapshot', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      button('+').click();
    });
    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(3);

    await act(async () => {
      await saveActiveBumpChartWorkspace({
        version: 2,
        view: 'staging',
        columns: [
          emptyWorkspaceColumn('previous-1', 'previous'),
          emptyWorkspaceColumn('current', 'current'),
        ],
        bestMatchByTitle: true,
        lastImportTab: 'single',
      });
    });
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STATE_REVISION_KEY,
          newValue: JSON.stringify({
            scope: 'bump',
            id: 'active',
            source: 'another-tab',
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(3);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Remove Current order"]',
        )
        ?.click();
    });
    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(2);

    await act(async () => {
      await saveActiveBumpChartWorkspace({
        version: 2,
        view: 'staging',
        columns: [
          emptyWorkspaceColumn('previous-1', 'previous'),
          emptyWorkspaceColumn('previous-2', 'previous'),
          emptyWorkspaceColumn('previous-3', 'previous'),
          emptyWorkspaceColumn('current', 'current'),
        ],
        bestMatchByTitle: true,
        lastImportTab: 'single',
      });
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STATE_REVISION_KEY,
          newValue: JSON.stringify({
            scope: 'bump',
            id: 'active',
            source: 'another-tab',
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelectorAll('.bump-chart-import-card')).toHaveLength(2);
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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

    await act(async () => {
      button('Results').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      root.unmount();
      await flushBumpChartStorageWrites();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      button('Import ranked items').click();
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
    expect(container.textContent).toContain('From chart');
    const restoredGroups = container.querySelectorAll<HTMLButtonElement>(
      '.bump-chart-import-card .staged-panel-group-row',
    );
    await act(async () => {
      restoredGroups.forEach((group) => group.click());
    });
    expect(container.textContent).toContain('Before item');
    expect(container.textContent).toContain('After item');
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

  it('pins only paths and nodes, not item labels', async () => {
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
    expect(inferredMarkers[0]?.dataset.preferredPathPosition).toBe('0.95');
    expect(Number(inferredMarkers[0]?.dataset.pathPosition)).toBeLessThanOrEqual(
      0.95,
    );
    expect(
      inferredMarkers[0]?.querySelector('.bump-chart-inferred-icon'),
    ).not.toBeNull();
    expect(inferredMarkers[0]?.querySelector('text')).toBeNull();
    expect(inferredMarkers[0]?.querySelector('title')?.textContent).toBe(
      'Inferred match from an exact label',
    );
    expect(inferredMarkers[0]?.getAttribute('tabindex')).toBe('0');
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

    const secondLineageLabel =
      container.querySelectorAll<HTMLElement>('.bump-chart-item-link')[1];
    expect(secondLineageLabel?.hasAttribute('data-bump-lineage')).toBe(false);
    await act(async () => {
      secondLineageLabel?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      secondLineageLabel?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true }),
      );
    });
    expect(connections[0]?.classList.contains('is-active')).toBe(false);
    expect(connections[1]?.classList.contains('is-active')).toBe(false);

    const nodes = container.querySelectorAll<SVGCircleElement>(
      '.bump-chart-node',
    );
    await act(async () => {
      nodes[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(connections[1]?.classList.contains('is-active')).toBe(true);

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(connections[1]?.classList.contains('is-active')).toBe(true);

    await act(async () => {
      container
        .querySelector('.bump-chart-center-cell')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container.querySelector('.bump-chart-connection.is-active'),
    ).toBeNull();
    expect(
      container.querySelector('.bump-chart-connection.is-dimmed'),
    ).toBeNull();
  });

  it('reacts to Best match by title changes for an existing chart', async () => {
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

  it('hides staged groups and allows restoring them', async () => {
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
    expect(container.textContent).toContain(
      '0 unique items ready across 1 source · 1 hidden',
    );
    const undo = container.querySelector<HTMLButtonElement>(
      '.bump-chart-import-card:first-of-type .staged-panel-group-undo',
    );
    expect(undo).not.toBeNull();

    await act(async () => {
      undo?.click();
    });
    expect(container.textContent).toContain('1 unique item ready across 1 source');
    expect(container.textContent).not.toContain('0 hidden');
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

  it('soft-hides only the selected endpoint of a matched lineage', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Matched item');
    await importSingle(1, 'Matched item');
    await act(async () => {
      button('Generate chart').click();
    });
    await act(async () => {
      button('#1', 0).click();
    });
    expect(button('Remove')).toBeTruthy();

    await act(async () => {
      button('Remove').click();
    });
    expect(container.querySelectorAll('.bump-chart-rank')).toHaveLength(1);
    expect(
      container.querySelector('.bump-chart-change-marker--added'),
    ).not.toBeNull();

    await act(async () => {
      button('Clear chart').click();
    });
    const restoredGroups = container.querySelectorAll<HTMLButtonElement>(
      '.bump-chart-import-card .staged-panel-group-row',
    );
    await act(async () => {
      restoredGroups.forEach((group) => group.click());
    });
    expect(container.textContent).toContain('Matched item');
    const restoreButtons = container.querySelectorAll<HTMLButtonElement>(
      '.staged-panel-item-undo',
    );
    expect(restoreButtons).toHaveLength(1);
    await act(async () => {
      restoreButtons.forEach((restore) => restore.click());
    });
    await act(async () => {
      button('Generate chart').click();
    });
    expect(container.querySelectorAll('.bump-chart-rank')).toHaveLength(2);
  });

  it('soft-hides only an unmatched item and collapses the visible ranks', async () => {
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
    });
    await importSingle(0, 'Still ranked');
    await importSingle(0, 'Removed item');
    await importSingle(1, 'Still ranked');
    await act(async () => {
      button('Generate chart').click();
    });
    await act(async () => {
      button('#2').click();
    });
    await act(async () => {
      button('Remove').click();
    });

    expect(container.querySelectorAll('.bump-chart-rank')).toHaveLength(2);
    expect(container.querySelector('.bump-chart-grid')?.textContent).not.toContain(
      'Removed item',
    );
    expect(
      Array.from(container.querySelectorAll('.bump-chart-rank')).map(
        (rank) => rank.textContent,
      ),
    ).toEqual(['#1', '#1']);
  });

  it('restores the autosaved active generated workspace after remounting', async () => {
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
      button('+').click();
    });
    await importSingle(0, 'Autosaved oldest');
    await importSingle(1, 'Autosaved previous');
    await importSingle(2, 'Autosaved current');
    await act(async () => {
      button('Generate chart').click();
    });

    await act(async () => {
      root.unmount();
      await flushBumpChartStorageWrites();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('.bump-chart-grid')).not.toBeNull();
    expect(container.textContent).toContain('Autosaved oldest');
    expect(container.textContent).toContain('Autosaved previous');
    expect(container.textContent).toContain('Autosaved current');
    expect(container.querySelectorAll('.bump-chart-center-cell')).toHaveLength(2);
  });

  it('saves, loads, restores settings from, and deletes a named chart', async () => {
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
    await importSingle(0, 'Named before');
    await importSingle(1, 'Named after');
    await act(async () => {
      button('Generate chart').click();
    });
    await act(async () => {
      button('#1', 0).click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await act(async () => {
      button('Save chart…').click();
    });
    const nameInput = document.querySelector<HTMLInputElement>(
      '[aria-label="Save Bump Chart"] input',
    );
    if (!nameInput) {
      throw new Error('Save chart name input was not rendered');
    }
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(nameInput, 'My chart');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Save chart').click();
      await flushBumpChartStorageWrites();
    });
    await act(async () => {
      button('Clear chart').click();
    });
    expect(container.querySelector('.bump-chart-saved-charts')).not.toBeNull();
    expect(container.textContent).toContain('My chart');
    const savedChartsToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse saved charts"]',
    );
    const savedChartsCount = container.querySelector<HTMLElement>(
      '.bump-chart-saved-count',
    );
    expect(savedChartsToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(savedChartsCount?.closest('button')).toBe(savedChartsToggle);

    await act(async () => {
      savedChartsCount?.click();
    });
    const collapsedSavedCharts = container.querySelector(
      '.bump-chart-saved-charts',
    );
    expect(collapsedSavedCharts?.classList.contains('is-collapsed')).toBe(true);
    expect(collapsedSavedCharts?.textContent).toContain('Saved charts');
    expect(collapsedSavedCharts?.textContent).toContain('1 saved');
    expect(collapsedSavedCharts?.textContent).not.toContain('My chart');
    expect(container.querySelector('.bump-chart-saved-list')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushBumpChartStorageWrites();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BumpChartPanel
          dbSyncRevision={0}
          onOpenMedia={vi.fn()}
          onOpenStaff={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label="Expand saved charts"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(container.querySelector('.bump-chart-saved-list')).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Expand saved charts"]',
        )
        ?.click();
    });
    expect(container.querySelector('.bump-chart-saved-list')).not.toBeNull();

    await act(async () => {
      saveToolsPreferences({ bumpChartBestMatchByTitle: true });
      button('Load').click();
    });
    expect(container.querySelector('.bump-chart-grid')).toBeNull();
    expect(container.textContent).toContain('From saved chart');
    expect(loadToolsPreferences().bumpChartBestMatchByTitle).toBe(false);
    const loadedGroups = container.querySelectorAll<HTMLButtonElement>(
      '.bump-chart-import-card .staged-panel-group-row',
    );
    await act(async () => {
      loadedGroups.forEach((group) => group.click());
    });
    expect(container.querySelectorAll('.staged-panel-item-undo')).toHaveLength(1);

    await act(async () => {
      button('Delete').click();
    });
    await act(async () => {
      button('Confirm delete').click();
      await flushBumpChartStorageWrites();
    });
    expect(container.querySelector('.bump-chart-saved-charts')).toBeNull();
  });

  it('omits AniList images and preserves dimmed labels and pinned-line emphasis', async () => {
    const anilistImage =
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg';
    const chart = document.createElement('div');
    chart.style.backgroundColor = 'rgb(255, 255, 255)';
    chart.innerHTML =
      '<div class="bump-chart-row" style="border-bottom: 1px solid red"></div>' +
      '<div class="bump-chart-row" style="border-bottom-width: 0"></div>' +
      '<div class="bump-chart-timeline-cell" style="opacity: 1">' +
      '<div class="bump-chart-event-node" style="opacity: 0.24">' +
      '<a class="bump-chart-item-link"><img src="https://example.invalid/cover.jpg"></a></div></div>' +
      `<a class="bump-chart-item-link"><img src="${anilistImage}"></a>` +
      '<div class="bump-chart-label-cell" style="opacity: 0.24">' +
      '<span class="bump-chart-label">A<span>B</span></span></div>' +
      '<svg class="bump-chart-svg">' +
      '<g class="bump-chart-connection is-active" style="color: red; opacity: 1">' +
      '<path class="bump-chart-path" d="M 0 0 L 10 10"></path></g>' +
      '<g class="bump-chart-connection is-dimmed" style="color: blue; opacity: 0.24">' +
      '<path class="bump-chart-path" d="M 0 10 L 10 0"></path></g>' +
      '<g class="bump-chart-movement-badge" data-badge-label="+2" ' +
      'data-badge-width="28" data-badge-x="150" data-badge-y="100" ' +
      'data-png-exclude="true" style="color: green">' +
      '<rect style="fill: white; stroke: green"></rect>' +
      '<text style="fill: green; font: 600 11px sans-serif">+2</text></g></svg>';
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
    const rows = chart.querySelectorAll<HTMLElement>('.bump-chart-row');
    vi.spyOn(rows[0]!, 'getBoundingClientRect').mockReturnValue(
      domRect(300, 64, 0, 0),
    );
    vi.spyOn(rows[1]!, 'getBoundingClientRect').mockReturnValue(
      domRect(300, 64, 0, 64),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === 'https://example.invalid/cover.jpg') {
        return new Response(new Blob(['image'], { type: 'image/jpeg' }), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
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
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(readonly path: string) {}
      },
    );
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

    let globalAlpha = 1;
    const strokeAlphas: number[] = [];
    const strokeWidths: number[] = [];
    const drawImageAlphas: number[] = [];
    const fillTextAlphas: number[] = [];
    const context = {
      scale: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(() => {
        globalAlpha = 1;
      }),
      translate: vi.fn(),
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(() => {
        strokeAlphas.push(globalAlpha);
        strokeWidths.push(context.lineWidth);
      }),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      drawImage: vi.fn(() => {
        drawImageAlphas.push(globalAlpha);
      }),
      fillText: vi.fn(() => {
        fillTextAlphas.push(globalAlpha);
      }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    };
    Object.defineProperty(context, 'globalAlpha', {
      get: () => globalAlpha,
      set: (value: number) => {
        globalAlpha = value;
      },
    });
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
    const imageDisplayWhileDrawing: string[] = [];
    const anilistImageElement = imageElements[1]!;
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
          getBoundingClientRect: () => {
            imageDisplayWhileDrawing.push(anilistImageElement.style.display);
            return {
              x: 0,
              y: 0,
              top: 0,
              right: 8,
              bottom: 16,
              left: 0,
              width: 8,
              height: 16,
              toJSON: () => ({}),
            };
          },
        }) as unknown as Range,
    );

    await exportChartPng(chart, { includeImages: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/cover.jpg',
      { mode: 'cors' },
    );
    expect(fetchMock).not.toHaveBeenCalledWith(anilistImage, { mode: 'cors' });
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(drawImageAlphas).toEqual([0.24]);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(imageDisplayWhileDrawing).toContain('none');
    expect(anilistImageElement.style.display).toBe('');
    expect(rows[0]!.style.height).toBe('');
    expect(rows[1]!.style.height).toBe('');
    expect(context.fillText).toHaveBeenCalledWith('AB', 0, 0);
    expect(context.fillText).toHaveBeenCalledWith('+2', 150, 100);
    expect(context.roundRect).toHaveBeenCalledWith(136, 90, 28, 20, 10);
    expect(context.moveTo).toHaveBeenCalledOnce();
    expect(context.moveTo).toHaveBeenCalledWith(0, 63.5);
    expect(strokeAlphas).toEqual([1, 1, 0.24, 1, 0.24]);
    expect(strokeWidths).toEqual([1, 5, 3, 1, 2]);
    expect(fillTextAlphas).toContain(0.24);
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

  it('uses a persisted MAL fallback only when the export opt-in is enabled', async () => {
    const anilistImage =
      'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/test.jpg';
    const malImage =
      'https://cdn.myanimelist.net/images/anime/4/19644.jpg';
    localStorage.setItem(
      'queue-sorter:bump-mal-export-image-urls:v1',
      JSON.stringify({ 'anilist:1': malImage }),
    );
    _resetBumpMalExportImagesForTesting();

    const chart = document.createElement('div');
    chart.style.backgroundColor = 'rgb(255, 255, 255)';
    chart.innerHTML =
      `<a class="bump-chart-item-link" data-bump-item-id="anilist:1">` +
      `<img src="${anilistImage}"></a>`;
    document.body.appendChild(chart);
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue(
      domRect(300, 200),
    );
    const image = chart.querySelector('img')!;
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(
      domRect(38, 48, 10, 10),
    );

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
    const bitmap = { width: 100, height: 150, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const context = {
      scale: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      drawImage: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob(['png'])),
    );
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
      value: vi.fn(() => 'blob:chart'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      await exportChartPng(chart, {
        includeImages: false,
        itemsById: new Map([
          [
            'anilist:1',
            {
              id: 'anilist:1',
              label: 'Cowboy Bebop',
              imageUrl: anilistImage,
              source: { kind: 'anilist', externalId: 1 },
            },
          ],
        ]),
        useMalImages: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(context.drawImage).not.toHaveBeenCalled();
      expect(image.style.display).toBe('');

      await exportChartPng(chart, {
        includeImages: true,
        itemsById: new Map([
          [
            'anilist:1',
            {
              id: 'anilist:1',
              label: 'Cowboy Bebop',
              imageUrl: anilistImage,
              source: { kind: 'anilist', externalId: 1 },
            },
          ],
        ]),
        useMalImages: true,
      });
    } finally {
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
    }

    expect(fetchMock).toHaveBeenCalledWith(malImage, { mode: 'cors' });
    expect(fetchMock).not.toHaveBeenCalledWith(anilistImage, { mode: 'cors' });
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('restores collapsed image layout when canvas export is unavailable', async () => {
    const chart = document.createElement('div');
    chart.innerHTML =
      '<div class="bump-chart-row" style="height: 70px">' +
      '<a class="bump-chart-item-link">' +
      '<img src="https://s4.anilist.co/file/anilistcdn/test.jpg"></a></div>';
    const row = chart.querySelector<HTMLElement>('.bump-chart-row')!;
    const image = chart.querySelector<HTMLImageElement>('img')!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(domRect(300, 70));
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue(domRect(300, 70));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    await expect(exportChartPng(chart)).rejects.toThrow(
      'Canvas export is unavailable.',
    );

    expect(row.style.height).toBe('70px');
    expect(row.style.minHeight).toBe('');
    expect(row.style.maxHeight).toBe('');
    expect(image.style.display).toBe('');
  });
});

describe('bumpChartExportCanvasLayout', () => {
  it('uses the full scrollable timeline and downscales within canvas limits', () => {
    const chart = document.createElement('div');
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue(
      domRect(1_000, 600),
    );
    Object.defineProperties(chart, {
      scrollWidth: { configurable: true, value: 20_000 },
      scrollHeight: { configurable: true, value: 4_000 },
    });

    expect(bumpChartExportCanvasLayout(chart)).toEqual({
      width: 20_000,
      height: 4_000,
      scale: Math.sqrt(100_000_000 / 80_000_000),
      canvasWidth: 22_360,
      canvasHeight: 4_472,
    });
  });
});

describe('bumpTimelineColumnAnchorX', () => {
  it('places two-column endpoint nodes inside the connection corridor', () => {
    const rootLeft = 100;
    const leftCell = { left: 100, right: 460, width: 360 };
    const rightCell = { left: 740, right: 1100, width: 360 };

    const leftAnchor = bumpTimelineColumnAnchorX(
      0,
      2,
      rootLeft,
      leftCell,
    );
    const rightAnchor = bumpTimelineColumnAnchorX(
      1,
      2,
      rootLeft,
      rightCell,
    );

    expect(leftAnchor).toBe(372);
    expect(leftAnchor).toBeGreaterThan(leftCell.right - rootLeft);
    expect(rightAnchor).toBe(628);
    expect(rightAnchor).toBeLessThan(rightCell.left - rootLeft);
  });
});

describe('bumpTimelinePathEndpoints', () => {
  it('connects measured edges of nodes centered on their nominal column anchors', () => {
    expect(
      bumpTimelinePathEndpoints(
        300,
        700,
        { left: 195, right: 405 },
        { left: 595, right: 805 },
      ),
    ).toEqual({ startX: 405, endX: 595 });
  });
});

describe('bumpTimelinePathMidpoint', () => {
  it('aligns a movement badge with a path leading into an intermediate node', () => {
    expect(
      bumpTimelinePathMidpoint(
        300,
        700,
        null,
        { left: 595, right: 805 },
        40,
        80,
      ),
    ).toEqual({ x: 447.5, y: 60 });
  });

  it('aligns a movement badge with a path leading out of an intermediate node', () => {
    expect(
      bumpTimelinePathMidpoint(
        300,
        700,
        { left: 195, right: 405 },
        null,
        80,
        40,
      ),
    ).toEqual({ x: 552.5, y: 60 });
  });
});

describe('inferredMatchMarkerPosition', () => {
  it('prefers 95% while keeping the info icon clear of the right node', () => {
    const wide = inferredMatchMarkerPosition(1_000, 100, 100);
    expect(wide.pathPosition).toBe(0.95);

    const compact = inferredMatchMarkerPosition(280, 100, 100);
    expect(compact.pathPosition).toBeLessThan(0.95);
    expect(compact.nodeSeparation).toBeGreaterThanOrEqual(37.99);
  });
});
