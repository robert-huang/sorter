import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as cloud from '../../lib/cloud';
import type { CloudProvider } from '../../lib/cloud';
import { seedAsSorted } from '../../lib/insertionSort';
import * as storage from '../../lib/storage';
import type { AutosaveBlob } from '../../lib/storage';
import { SortResultsImportMode } from '../SortResultsImportMode';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

describe('SortResultsImportMode cloud entry point', () => {
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
    expect(container.textContent).not.toContain('Google Drive slots');
    const driveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Google Drive…',
    );
    act(() => driveButton?.click());
    expect(container.textContent).toContain('Google Drive slots');
    expect(container.textContent).toContain(
      'Sign in to Google Drive from Settings first.',
    );
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
});
