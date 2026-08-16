import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SORTER_IMPORT_LAST_TAB_LS_KEY,
  StartScreen,
} from '../StartScreen';
import type { SlotsManifest } from '../../lib/types';

vi.mock('../../lib/storage', async () => {
  const actual = await vi.importActual<typeof import('../../lib/storage')>(
    '../../lib/storage',
  );
  return {
    ...actual,
    isStatePersistenceAvailable: () => true,
  };
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.removeItem(SORTER_IMPORT_LAST_TAB_LS_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(SORTER_IMPORT_LAST_TAB_LS_KEY);
});

function renderStartScreen(
  key: string,
  sortResultsManifest?: SlotsManifest,
): void {
  root.render(
    <StartScreen
      key={key}
      resumeMeta={null}
      onResumeActive={vi.fn()}
      onStartScratch={vi.fn()}
      onStartPreranked={vi.fn()}
      onStartInsertion={vi.fn()}
      onStartAlreadySorted={vi.fn()}
      onStartConfirmation={vi.fn()}
      hasLoadedSession={false}
      onDraftActivity={vi.fn()}
      onDraftCapabilitiesChange={vi.fn()}
      dbSyncRevision={0}
      sortResultsManifest={sortResultsManifest}
    />,
  );
}

function tabByText(text: string): HTMLButtonElement {
  const tab = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!tab) throw new Error(`Missing tab: ${text}`);
  return tab;
}

describe('Sorter importer tabs', () => {
  it('restores and updates the last-used tab', async () => {
    localStorage.setItem(SORTER_IMPORT_LAST_TAB_LS_KEY, 'preranked');

    await act(async () => {
      renderStartScreen('first');
    });
    expect(
      tabByText('Merge pre-ranked lists').getAttribute('aria-selected'),
    ).toBe('true');

    await act(async () => {
      tabByText('Sort from scratch').click();
    });
    expect(localStorage.getItem(SORTER_IMPORT_LAST_TAB_LS_KEY)).toBe('scratch');

    await act(async () => {
      renderStartScreen('second');
    });
    expect(tabByText('Sort from scratch').getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('shows browser saves when storage hydrates without remounting the importer', async () => {
    localStorage.setItem(SORTER_IMPORT_LAST_TAB_LS_KEY, 'sortresults');
    const emptyManifest: SlotsManifest = {
      version: 1,
      activeId: null,
      slots: [],
    };
    const hydratedManifest: SlotsManifest = {
      version: 1,
      activeId: null,
      slots: [
        {
          id: 'hydrated',
          name: 'Hydrated browser save',
          createdAt: '2026-08-16T12:00:00.000Z',
          updatedAt: '2026-08-16T12:00:00.000Z',
          totalItems: 2,
          comparisons: 1,
          done: true,
        },
      ],
    };

    await act(async () => {
      renderStartScreen('hydration', emptyManifest);
    });
    expect(container.textContent).toContain('No saved slots yet.');

    await act(async () => {
      renderStartScreen('hydration', hydratedManifest);
    });
    expect(container.textContent).toContain('Hydrated browser save');
  });
});
