import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cloud from '../../lib/cloud';
import type { CloudProvider } from '../../lib/cloud';
import { seedAsSorted } from '../../lib/insertionSort';
import * as slotResultsImport from '../../lib/slotResultsImport';
import * as storage from '../../lib/storage';
import type { AutosaveBlob } from '../../lib/storage';
import { SortResultsImportMode } from '../SortResultsImportMode';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cloud._setCloudProviderForTesting(null);
  vi.restoreAllMocks();
});

function completedBlob(): AutosaveBlob {
  const state = seedAsSorted([
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
  ]);
  return {
    items: state.items,
    progress: state,
    undoRing: [],
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SortResultsImportMode cloud entry point', () => {
  it('keeps the selection toolbar for the sorter by default', () => {
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    vi.spyOn(
      slotResultsImport,
      'listSlotImportEntriesFromStorage',
    ).mockReturnValue([
      {
        meta: {
          id: 'sorter-save',
          name: 'Sorter save',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          totalItems: 2,
          comparisons: 1,
          done: true,
        },
        status: 'importable',
        itemCount: 2,
        items: [
          { id: 'AAAAAAAAAAAAAQ', label: 'Alpha' },
          { id: 'BBBBBBBBBBBBBQ', label: 'Beta' },
        ],
      },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SortResultsImportMode
          embedded
          onAppendToStaged={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('1 importable · 0 selected');
    expect(container.textContent).toContain('Select all completed');
    expect(container.textContent).toContain('Clear');
    expect(
      container.querySelector('[aria-label="Browser save sorting"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Search browser saves by name"]'),
    ).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('keeps browser saves as the default and opens Drive only on demand', () => {
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <SortResultsImportMode
          embedded
          onAppendToStaged={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain('Saved in this browser');
    expect(container.textContent).toContain(
      'Pick one or more completed saves.',
    );
    expect(container.textContent).not.toContain('Google Drive slots');
    const driveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Google Drive…',
    );
    act(() => driveButton?.click());
    expect(container.textContent).toContain('Google Drive slots');
    expect(container.textContent).toContain(
      'Pick one or more completed saves.',
    );
    expect(container.textContent).toContain(
      'Sign in to Google Drive from Settings first.',
    );
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the START heading and description while browsing Drive', () => {
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<SortResultsImportMode onAppendToStaged={vi.fn()} />);
    });
    const driveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Google Drive…',
    );
    act(() => driveButton?.click());

    expect(container.querySelector('h2')?.textContent).toBe('Sort results');
    expect(container.textContent).toContain(
      'Import final rankings from completed saves in this browser.',
    );
    expect(container.textContent).toContain('Google Drive slots');

    act(() => root.unmount());
    container.remove();
  });

  it('imports a legacy completed body even when metadata repair fails', async () => {
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    const annotate = vi.fn().mockRejectedValue(new Error('Drive denied the PATCH'));
    const provider: CloudProvider = {
      signIn: vi.fn(),
      handleAuthRedirect: vi.fn(),
      signOut: vi.fn(),
      getAuthState: () => ({ status: 'signed-in', folderId: 'folder-1' }),
      refreshTokenIfNeeded: vi.fn(),
      pickFolder: vi.fn(),
      clearFolder: vi.fn(),
      subscribeAuthChange: vi.fn(() => () => undefined),
      listCloudSlots: vi.fn().mockResolvedValue([
        {
          cloudId: 'cloud-1',
          displayName: 'Legacy complete',
          filename: 'legacy.sorter',
          sizeBytes: 100,
          updatedAt: '2026-01-01T00:00:00.000Z',
          etag: 'etag-1',
        },
      ]),
      pullSlot: vi.fn().mockResolvedValue({
        blob: completedBlob(),
        etag: 'etag-1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      annotateSlotCompletion: annotate,
      pushSlot: vi.fn(),
      removeCloudSlot: vi.fn(),
    };
    cloud._setCloudProviderForTesting(provider);
    expect(cloud.getAuthState()).toMatchObject({ status: 'signed-in' });
    await expect(cloud.listCloudSlots()).resolves.toHaveLength(1);
    const onAppendToStaged = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SortResultsImportMode
          embedded
          onAppendToStaged={onAppendToStaged}
        />,
      );
    });

    const click = async (label: string): Promise<void> => {
      const target = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!target) {
        throw new Error(`Missing button: ${label}; content: ${container.textContent}`);
      }
      await act(async () => {
        target.click();
        await Promise.resolve();
      });
    };
    await click('Google Drive…');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await click('Check & load');

    expect(annotate).toHaveBeenCalledWith('cloud-1', true);
    expect(container.textContent).toContain(
      'Loaded, but completion metadata could not be updated: Drive denied the PATCH',
    );
    expect(container.textContent).toContain('Import from Drive (2)');

    await click('Import from Drive (2)');
    expect(onAppendToStaged).toHaveBeenCalledWith([
      {
        kind: 'sublist',
        source: 'Cloud sort: Legacy complete',
        items: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
      },
    ]);
    act(() => root.unmount());
    container.remove();
  });

  it('right-click sends a Drive slot through the new-order import path', async () => {
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    const provider: CloudProvider = {
      signIn: vi.fn(),
      handleAuthRedirect: vi.fn(),
      signOut: vi.fn(),
      getAuthState: () => ({ status: 'signed-in', folderId: 'folder-1' }),
      refreshTokenIfNeeded: vi.fn(),
      pickFolder: vi.fn(),
      clearFolder: vi.fn(),
      subscribeAuthChange: vi.fn(() => () => undefined),
      listCloudSlots: vi.fn().mockResolvedValue([
        {
          cloudId: 'cloud-ranked',
          displayName: 'Drive rankings',
          filename: 'drive-rankings.sorter',
          sizeBytes: 100,
          updatedAt: '2026-01-01T00:00:00.000Z',
          etag: 'etag-ranked',
          done: true,
        },
      ]),
      pullSlot: vi.fn().mockResolvedValue({
        blob: completedBlob(),
        etag: 'etag-ranked',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      annotateSlotCompletion: vi.fn(),
      pushSlot: vi.fn(),
      removeCloudSlot: vi.fn(),
    };
    cloud._setCloudProviderForTesting(provider);
    const onImportOrderedItems = vi.fn();
    const onImportOrderedItemsAsNewOrders = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SortResultsImportMode
          embedded
          onImportOrderedItems={onImportOrderedItems}
          onImportOrderedItemsAsNewOrders={
            onImportOrderedItemsAsNewOrders
          }
        />,
      );
    });

    const click = async (label: string): Promise<void> => {
      const target = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!target) throw new Error(`Missing button: ${label}`);
      await act(async () => {
        target.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await click('Google Drive…');
    await click('Load');

    const importButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent?.trim() === 'Import from Drive (2)',
    );
    expect(importButton).toBeDefined();
    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    await act(async () => {
      expect(importButton!.dispatchEvent(contextMenu)).toBe(false);
      await Promise.resolve();
    });

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(container.textContent).toContain('Google Drive slots');
    const clearedImportButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find(
      (candidate) =>
        candidate.textContent?.trim() === 'Import from Drive (0)',
    );
    expect(clearedImportButton?.disabled).toBe(true);
    expect(clearedImportButton?.title).toBe(
      'Left-click to import into the selected order. Right-click to append as a new order, keep this dialog open, and clear the selection.',
    );
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Select Drive rankings"]',
      )?.checked,
    ).toBe(false);
    expect(onImportOrderedItems).not.toHaveBeenCalled();
    expect(onImportOrderedItemsAsNewOrders).toHaveBeenCalledWith([
      {
        source: 'Cloud sort: Drive rankings',
        slotName: 'Drive rankings',
        items: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ],
      },
    ]);
    act(() => root.unmount());
    container.remove();
  });

  it('uses and updates the shared persisted cloud-slot order', async () => {
    window.localStorage.setItem(
      storage.SETTINGS_KEY,
      JSON.stringify({
        cloudSlotSortKey: 'title',
        cloudSlotSortDirection: 'asc',
      }),
    );
    vi.spyOn(storage, 'isStatePersistenceAvailable').mockReturnValue(true);
    const provider: CloudProvider = {
      signIn: vi.fn(),
      handleAuthRedirect: vi.fn(),
      signOut: vi.fn(),
      getAuthState: () => ({ status: 'signed-in', folderId: 'folder-1' }),
      refreshTokenIfNeeded: vi.fn(),
      pickFolder: vi.fn(),
      clearFolder: vi.fn(),
      subscribeAuthChange: vi.fn(() => () => undefined),
      listCloudSlots: vi.fn().mockResolvedValue([
        {
          cloudId: 'cloud-gamma',
          displayName: 'Gamma',
          filename: 'gamma.sorter',
          sizeBytes: 100,
          updatedAt: '2026-03-03T00:00:00.000Z',
          etag: 'etag-gamma',
        },
        {
          cloudId: 'cloud-alpha',
          displayName: 'Alpha',
          filename: 'alpha.sorter',
          sizeBytes: 100,
          updatedAt: '2026-02-02T00:00:00.000Z',
          etag: 'etag-alpha',
        },
      ]),
      pullSlot: vi.fn(),
      annotateSlotCompletion: vi.fn(),
      pushSlot: vi.fn(),
      removeCloudSlot: vi.fn(),
    };
    cloud._setCloudProviderForTesting(provider);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SortResultsImportMode embedded onAppendToStaged={vi.fn()} />,
      );
    });
    const driveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Google Drive…',
    );
    await act(async () => {
      driveButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const rowNames = (): string[] =>
      Array.from(
        container.querySelectorAll<HTMLElement>('.sort-results-import-row-title'),
      ).map((element) => element.textContent ?? '');
    expect(rowNames()).toEqual(['Alpha', 'Gamma']);

    const titleButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Title ↑',
    );
    act(() => titleButton?.click());
    expect(rowNames()).toEqual(['Gamma', 'Alpha']);
    expect(storage.readSettings()).toMatchObject({
      cloudSlotSortKey: 'title',
      cloudSlotSortDirection: 'desc',
    });

    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search cloud slots by name"]',
    );
    expect(search).not.toBeNull();
    act(() => setInputValue(search!, 'alpha'));
    expect(rowNames()).toEqual(['Alpha']);
    act(() => setInputValue(search!, 'missing'));
    expect(rowNames()).toEqual([]);
    expect(container.textContent).toContain('No Drive slots match “missing”.');

    act(() => root.unmount());
    container.remove();
  });
});
