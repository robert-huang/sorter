import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SORTER_IMPORT_LAST_TAB_LS_KEY,
  StartScreen,
} from '../StartScreen';

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

function renderStartScreen(key: string): void {
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
});
