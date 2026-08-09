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

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderModal(onPull = vi.fn()): Promise<void> {
  cloudMocks.listCloudSlots.mockResolvedValue(rows);
  await act(async () => {
    root.render(
      <CloudLibraryModal
        onClose={vi.fn()}
        onPull={onPull}
        localCloudSlotByCloudId={new Map()}
        onOpenLocalSlot={vi.fn()}
        onRemoveLocalSlot={vi.fn()}
        onSignedOut={vi.fn()}
        onFolderChanged={vi.fn()}
      />,
    );
  });
}

describe('CloudLibraryModal pull controls', () => {
  it('pulls and activates a slot on a normal click', async () => {
    const onPull = vi.fn();
    await renderModal(onPull);

    await act(async () => button('Pull').click());

    expect(onPull).toHaveBeenCalledOnce();
    expect(onPull).toHaveBeenCalledWith(rows[1], { activate: true });
  });

  it('pulls without activating on right-click and explains the shortcut', async () => {
    const onPull = vi.fn();
    await renderModal(onPull);
    const pullButton = button('Pull');
    const contextMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    });

    expect(pullButton.title).toContain(
      'Right-click to pull without opening it.',
    );
    await act(async () => {
      pullButton.dispatchEvent(contextMenu);
    });

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(onPull).toHaveBeenCalledOnce();
    expect(onPull).toHaveBeenCalledWith(rows[1], { activate: false });
  });
});

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

  it('sorts digit-heavy titles lexically instead of treating dates as numbers', () => {
    const datedRows = [
      cloudSlot('short-202403', 'archive/chars 202403', '2026-01-01'),
      cloudSlot('short-202607', 'archive/chars 202607', '2026-01-02'),
      cloudSlot('long-20211008', 'archive/chars 20211008', '2026-01-03'),
      cloudSlot('long-20230918', 'archive/chars 20230918', '2026-01-04'),
      cloudSlot('long-20260806', 'archive/chars 20260806', '2026-01-05'),
    ];

    expect(
      sortCloudLibraryRows(datedRows, 'title', 'asc').map(
        (row) => row.displayName,
      ),
    ).toEqual([
      'archive/chars 20211008',
      'archive/chars 20230918',
      'archive/chars 202403',
      'archive/chars 202607',
      'archive/chars 20260806',
    ]);
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

  it('filters cloud slots by name without changing the selected sort', async () => {
    await renderModal();
    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search cloud slots by name"]',
    );
    expect(search).not.toBeNull();

    act(() => setInputValue(search!, 'BET'));
    expect(rowNames()).toEqual(['beta']);
    expect(button('Date ↓').getAttribute('aria-pressed')).toBe('true');

    act(() => setInputValue(search!, 'missing'));
    expect(rowNames()).toEqual([]);
    expect(container.textContent).toContain('No cloud slots match “missing”.');
  });
});
