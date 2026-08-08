import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSlotMeta } from '../../lib/cloud';
import { readSettings } from '../../lib/storage';
import {
  CloudLibraryModal,
  sortCloudLibraryRows,
} from '../CloudLibraryModal';

const cloudMocks = vi.hoisted(() => ({
  listCloudSlots: vi.fn<() => Promise<CloudSlotMeta[]>>(),
}));

vi.mock('../../lib/cloud', () => ({
  getAuthState: () => ({
    status: 'signed-in',
    folderId: 'folder-1',
    folderName: 'Sorter backups',
  }),
  listCloudSlots: cloudMocks.listCloudSlots,
  pickFolder: vi.fn(),
  signOut: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  cloudMocks.listCloudSlots.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function cloudSlot(
  cloudId: string,
  displayName: string,
  updatedAt: string,
): CloudSlotMeta {
  return {
    cloudId,
    displayName,
    filename: `${displayName}.sorter.json`,
    sizeBytes: 100,
    updatedAt,
    etag: `etag-${cloudId}`,
  };
}

const rows = [
  cloudSlot('alpha', 'Alpha', '2026-02-02T00:00:00.000Z'),
  cloudSlot('gamma', 'Gamma', '2026-03-03T00:00:00.000Z'),
  cloudSlot('beta', 'beta', '2026-01-01T00:00:00.000Z'),
];

function rowNames(): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.cloud-library-row-name'),
  ).map((element) => element.textContent ?? '');
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

async function renderModal(): Promise<void> {
  cloudMocks.listCloudSlots.mockResolvedValue(rows);
  await act(async () => {
    root.render(
      <CloudLibraryModal
        onClose={vi.fn()}
        onPull={vi.fn()}
        localCloudSlotByCloudId={new Map()}
        onOpenLocalSlot={vi.fn()}
        onRemoveLocalSlot={vi.fn()}
        onSignedOut={vi.fn()}
        onFolderChanged={vi.fn()}
      />,
    );
  });
}

describe('sortCloudLibraryRows', () => {
  it.each([
    ['title', 'asc', ['Alpha', 'beta', 'Gamma']],
    ['title', 'desc', ['Gamma', 'beta', 'Alpha']],
    ['date', 'asc', ['beta', 'Alpha', 'Gamma']],
    ['date', 'desc', ['Gamma', 'Alpha', 'beta']],
  ] as const)('sorts by %s %s', (sortKey, direction, expected) => {
    expect(
      sortCloudLibraryRows(rows, sortKey, direction).map(
        (row) => row.displayName,
      ),
    ).toEqual(expected);
  });

  it('preserves source order when the selected values tie', () => {
    const tied = [
      cloudSlot('first', 'Same', '2026-01-01T00:00:00.000Z'),
      cloudSlot('second', 'same', '2026-02-02T00:00:00.000Z'),
    ];

    expect(
      sortCloudLibraryRows(tied, 'title', 'desc').map((row) => row.cloudId),
    ).toEqual(['first', 'second']);
  });
});

describe('CloudLibraryModal sorting controls', () => {
  it('persists the selected order across modal instances', async () => {
    await renderModal();
    expect(rowNames()).toEqual(['Gamma', 'Alpha', 'beta']);
    expect(button('Date ↓').getAttribute('aria-pressed')).toBe('true');

    await act(async () => button('Date ↓').click());
    expect(rowNames()).toEqual(['beta', 'Alpha', 'Gamma']);
    expect(button('Date ↑').getAttribute('aria-pressed')).toBe('true');

    await act(async () => button('Title').click());
    expect(rowNames()).toEqual(['Alpha', 'beta', 'Gamma']);
    expect(button('Title ↑').getAttribute('aria-pressed')).toBe('true');

    await act(async () => button('Title ↑').click());
    expect(rowNames()).toEqual(['Gamma', 'beta', 'Alpha']);
    expect(button('Title ↓').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).not.toContain('Ascending');
    expect(container.textContent).not.toContain('Descending');
    expect(readSettings()).toMatchObject({
      cloudSlotSortKey: 'title',
      cloudSlotSortDirection: 'desc',
    });

    act(() => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    await renderModal();
    expect(rowNames()).toEqual(['Gamma', 'beta', 'Alpha']);
  });
});
