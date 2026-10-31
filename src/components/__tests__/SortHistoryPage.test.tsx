import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedAsSorted } from '../../lib/insertionSort';
import { _resetStateStorageForTesting } from '../../lib/stateStorageDb';
import {
  _resetSorterStorageCacheForTesting,
  createSlot,
  flushStateStorageWrites,
} from '../../lib/storage';
import type { Item, SortVersion } from '../../lib/types';
import { SortHistoryPage } from '../SortHistoryPage';

const A: Item = { id: 'AAAAAAAAAAAAAQ', label: 'Alpha' };
const B: Item = { id: 'BBBBBBBBBBBBBQ', label: 'Beta' };
const C: Item = { id: 'QQQQQQQQQQQQQg', label: 'Gamma' };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  await flushStateStorageWrites();
  localStorage.clear();
  await _resetStateStorageForTesting();
  _resetSorterStorageCacheForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  await flushStateStorageWrites();
  container.remove();
});

function doneBlob(order: Item[]) {
  const state = seedAsSorted(order);
  return { items: state.items, progress: state, undoRing: [] };
}

function saveFile(order: Item[], name: string, lastModified: number, done = true): File {
  const blob = doneBlob(order);
  const text = JSON.stringify({
    version: 4,
    createdAt: 'x',
    ...blob,
    progress: { ...blob.progress, done },
  });
  return { name, lastModified, text: async () => text } as unknown as File;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

/** Opens a date field, types into its text box and presses Enter. */
async function typeDate(label: string, text: string): Promise<void> {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Edit ${label}"]`)!.click(),
  );
  const input = document.querySelector<HTMLInputElement>(`[aria-label="${label} text"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

async function upload(files: File[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Save files to import as versions"]',
  )!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SortHistoryPage', () => {
  it('turns an uploaded save and a browser save into versions on the active save', async () => {
    const slot = createSlot(doneBlob([B, C, A]), 'Archived copy');
    expect(slot).not.toBeNull();
    const fileDate = Date.parse('2026-01-05T12:00:00');
    const existing: SortVersion = {
      id: 'current',
      createdAt: '2099-01-01T00:00:00.000Z',
      rankedIds: [A.id, B.id, C.id],
      items: { [A.id]: { label: 'Alpha' }, [B.id]: { label: 'Beta' }, [C.id]: { label: 'Gamma' } },
    };
    const onApply = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <SortHistoryPage versions={[existing]} onApply={onApply} onClose={onClose} />,
      );
    });

    await upload([
      saveFile([C, B, A], 'january.json', fileDate),
      saveFile([A, C], 'unfinished.json', fileDate, false),
    ]);
    expect(document.body.textContent).toContain(
      'unfinished.json: in progress — only finished sorts can be imported',
    );

    await act(async () => button('Import sorter slot…').click());
    await act(async () => {
      document.querySelector<HTMLInputElement>('[aria-label="Select Archived copy"]')!.click();
    });
    await act(async () => button('Import 1 slot from browser').click());
    // The picker stays open with its selection cleared, ready for another import.
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Select Archived copy"]')?.checked,
    ).toBe(false);
    expect(button('Import from browser').disabled).toBe(true);

    const rows = Array.from(
      document.querySelectorAll(
        '[aria-label="Staged versions"] .sort-history-import-row .sort-history-import-name',
      ),
      (el) => el.textContent,
    );
    expect(rows).toEqual(['january', 'Archived copy']);
    expect(
      document.querySelector('[aria-label="Edit Date for january"]')?.textContent,
    ).toBe('2026-01-05 12:00');

    await act(async () => button('Save changes').click());
    expect(document.body.textContent).toContain('Adds 2 versions.');
    await act(async () => button('Confirm').click());

    const applied = onApply.mock.calls[0]![0] as SortVersion[];
    expect(applied.map((v) => v.rankedIds)).toEqual([
      [C.id, B.id, A.id],
      [B.id, C.id, A.id],
      [A.id, B.id, C.id],
    ]);
    expect(applied[0]!.createdAt).toBe(new Date(fileDate).toISOString());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Saved · 3 versions');
  });

  it('applies an edited date and skips a ranking identical to its predecessor', async () => {
    const onApply = vi.fn();
    act(() => {
      root.render(<SortHistoryPage versions={[]} onApply={onApply} onClose={vi.fn()} />);
    });
    await upload([
      saveFile([A, B], 'one.json', Date.parse('2026-02-01T08:00:00')),
      saveFile([A, B], 'two.json', Date.parse('2026-03-01T08:00:00')),
    ]);
    await typeDate('Date for one', '2025-12-24 18:30');
    const duplicateRows = Array.from(
      document.querySelectorAll('[aria-label="Staged versions"] li.is-duplicate'),
    ).map((row) => row.querySelector('.sort-history-import-name')?.textContent);
    expect(duplicateRows).toEqual(['two']);

    await act(async () => button('Save changes').click());
    expect(document.body.textContent).toContain('Adds 1 version; 1 identical ranking skipped.');
    await act(async () => button('Confirm').click());
    const applied = onApply.mock.calls[0]![0] as SortVersion[];
    expect(applied).toHaveLength(1);
    expect(applied[0]!.createdAt).toBe(new Date('2025-12-24T18:30').toISOString());
  });

  it("stages a file's current ranking once when it matches its newest version", async () => {
    const versionDate = new Date('2026-10-31T00:35').toISOString();
    const file = saveFile([A, B, C], 'matching.json', Date.parse('2026-10-31T00:37'));
    const text = JSON.parse(await file.text()) as Record<string, unknown>;
    text.versions = [
      {
        id: 'vAAAAAAAAAAAAA',
        createdAt: versionDate,
        rankedIds: [A.id, B.id, C.id],
        items: { [A.id]: { label: A.label }, [B.id]: { label: B.label }, [C.id]: { label: C.label } },
        live: true,
      },
    ];
    const withVersion = {
      name: 'matching.json',
      lastModified: Date.parse('2026-10-31T00:37'),
      text: async () => JSON.stringify(text),
    } as unknown as File;
    const onApply = vi.fn();
    act(() => {
      root.render(<SortHistoryPage versions={[]} onApply={onApply} onClose={vi.fn()} />);
    });
    await upload([withVersion]);

    expect(document.querySelector('[aria-label="Staged versions"] li.is-duplicate')).toBeNull();
    expect(
      document.querySelector('[aria-label="Edit Date for matching"]')?.textContent,
    ).toBe('2026-10-31 00:35');
    await act(async () => button('Save changes').click());
    expect(document.body.textContent).toContain('Adds 1 version.');
    expect(document.body.textContent).not.toContain('identical ranking');
  });

  it('redates and deletes recorded versions, re-sorting on save', async () => {
    const snap = (id: string, createdAt: string, order: Item[]): SortVersion => ({
      id,
      createdAt,
      rankedIds: order.map((it) => it.id),
      items: Object.fromEntries(order.map((it) => [it.id, { label: it.label }])),
    });
    const versions = [
      snap('one', new Date('2026-01-01T09:00').toISOString(), [A, B, C]),
      snap('two', new Date('2026-02-01T09:00').toISOString(), [B, A, C]),
      snap('three', new Date('2026-03-01T09:00').toISOString(), [C, B, A]),
      { ...snap('four', new Date('2026-04-01T09:00').toISOString(), [C, A, B]), live: true as const },
    ];
    const onApply = vi.fn();
    act(() => {
      root.render(<SortHistoryPage versions={versions} onApply={onApply} onClose={vi.fn()} />);
    });
    const toggles = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.sort-history-version-toggle'),
    );
    expect(toggles.map((t) => t.textContent?.replace(/^[▸▾]\s*/, ''))).toEqual([
      '1 up · 1 down',
      '1 up · 2 down',
      '1 up · 1 down',
      'First version',
    ]);
    await act(async () => toggles[1]!.click());
    expect(
      Array.from(document.querySelectorAll('.sort-version-ranking-row'), (row) => row.textContent),
    ).toEqual(['1Gamma↑2', '2Beta↓1', '3Alpha↓1']);

    await typeDate('Date for version from 2026-01-01 09:00', '2026-02-15 09:00');
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete version from 2026-03-01 09:00"]')!
        .click(),
    );

    await act(async () => button('Save changes').click());
    expect(document.body.textContent).toContain('Deletes 1; redates 1.');
    await act(async () => button('Confirm').click());
    const applied = onApply.mock.calls[0]![0] as SortVersion[];
    expect(applied.map((v) => v.rankedIds)).toEqual([
      [B.id, A.id, C.id],
      [A.id, B.id, C.id],
      [C.id, A.id, B.id],
    ]);
    expect(applied.map((v) => v.live)).toEqual([undefined, undefined, true]);
  });

  it('deleting the current version previews restoring the newest remaining ranking', async () => {
    const snap = (id: string, createdAt: string, order: Item[]): SortVersion => ({
      id,
      createdAt,
      rankedIds: order.map((it) => it.id),
      items: Object.fromEntries(order.map((it) => [it.id, { label: it.label }])),
    });
    const versions = [
      snap('one', new Date('2026-01-01T09:00').toISOString(), [A, B, C]),
      { ...snap('two', new Date('2026-02-01T09:00').toISOString(), [C, B, A]), live: true as const },
    ];
    const onApply = vi.fn();
    act(() => {
      root.render(<SortHistoryPage versions={versions} onApply={onApply} onClose={vi.fn()} />);
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete version from 2026-02-01 09:00"]')!
        .click(),
    );
    await act(async () => button('Save changes').click());
    expect(document.body.textContent).toContain(
      'The ranking becomes the version from 2026-01-01 09:00; items it lacks are hidden.',
    );
    await act(async () => button('Confirm').click());
    const applied = onApply.mock.calls[0]![0] as SortVersion[];
    expect(applied.map((v) => v.rankedIds)).toEqual([[A.id, B.id, C.id]]);
  });
});
