import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../../lib/types';

vi.mock(
  '../../lib/importers/anilist/anilistItemMaterialization',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../lib/importers/anilist/anilistItemMaterialization')
      >();
    return {
      ...actual,
      listCachedAnilistSources: vi.fn(async () => []),
      materializeCachedAnilistSource: vi.fn(async () => []),
    };
  },
);

import { canonicalKey } from '../../lib/csv';
import { ADD_ITEMS_LAST_TAB_LS_KEY, AddItemsModal } from '../AddItemsModal';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.removeItem(ADD_ITEMS_LAST_TAB_LS_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(ADD_ITEMS_LAST_TAB_LS_KEY);
});

interface Handlers {
  onAddMany: ReturnType<typeof vi.fn<(items: Item[]) => void>>;
  onAddPreRanked: ReturnType<typeof vi.fn<(items: Item[]) => void>>;
}

async function renderMultiple(options: {
  existingIds?: string[];
  hiddenIds?: string[];
} = {}): Promise<Handlers> {
  const handlers: Handlers = {
    onAddMany: vi.fn<(items: Item[]) => void>(),
    onAddPreRanked: vi.fn<(items: Item[]) => void>(),
  };
  const hidden = new Set(options.hiddenIds ?? []);
  await act(async () => {
    root.render(
      <AddItemsModal
        engine="merge"
        existingIds={new Set([...(options.existingIds ?? []), ...hidden])}
        hiddenRestoreIds={hidden}
        dbSyncRevision={0}
        initialTab="multiple"
        onCancel={vi.fn()}
        onAddOne={vi.fn()}
        onAddMany={handlers.onAddMany}
        onAddPreRanked={handlers.onAddPreRanked}
      />,
    );
  });
  return handlers;
}

function setFieldValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function paste(text: string): Promise<void> {
  await act(async () => {
    setFieldValue(container.querySelector<HTMLTextAreaElement>('.csv-textarea')!, text);
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function buttonByAria(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function stagedLabels(): string[] {
  return Array.from(
    container.querySelectorAll('.add-items-staging .preview-item-label'),
  ).map((el) => el.textContent ?? '');
}

function statusFor(label: string): string | null {
  const row = Array.from(
    container.querySelectorAll('.add-items-staging .preview-items li'),
  ).find((li) => li.querySelector('.preview-item-label')?.textContent === label);
  return row?.querySelector('.preview-item-status')?.textContent ?? null;
}

describe('Add items Multiple tab staging area', () => {
  it('uses the wide modal size and hides the preview Start button', async () => {
    await renderMultiple();
    await paste('Inception\nHeat');

    expect(container.querySelector('.modal.modal-wide-multiple')).not.toBeNull();
    expect(container.querySelector('.add-items-staging .preview-start-row')).toBeNull();
    expect(buttonByText('Add 2 items')).toBeTruthy();
  });

  it('only applies the wide size to the Multiple tab', async () => {
    await renderMultiple();
    await act(async () => buttonByText('Single').click());
    expect(container.querySelector('.modal.modal-wide-multiple')).toBeNull();
    expect(container.querySelector('.modal.modal-add-items')).not.toBeNull();
  });

  it('lists parsed rows with skip and reinsert status', async () => {
    await renderMultiple({
      existingIds: [canonicalKey('Heat')],
      hiddenIds: [canonicalKey('Alien')],
    });
    await paste('Inception\nHeat\nAlien');

    expect(stagedLabels()).toEqual(['Inception', 'Heat', 'Alien']);
    expect(statusFor('Inception')).toBeNull();
    expect(statusFor('Heat')).toBe('already in sort');
    expect(statusFor('Alien')).toBe('hidden · reinsert');
  });

  it('removing a row drops it from the add and updates the count', async () => {
    const { onAddMany } = await renderMultiple();
    await paste('Inception\nHeat\nAlien');

    await act(async () => buttonByAria('Remove Heat').click());

    expect(stagedLabels()).toEqual(['Inception', 'Alien']);
    await act(async () => buttonByText('Add 2 items').click());
    expect(onAddMany).toHaveBeenCalledWith([
      expect.objectContaining({ label: 'Inception' }),
      expect.objectContaining({ label: 'Alien' }),
    ]);
  });

  it('editing a row changes the label that gets added', async () => {
    const { onAddMany } = await renderMultiple();
    await paste('Inception\nHeat');

    await act(async () => buttonByAria('Edit Heat').click());
    const labelInput = container.querySelector<HTMLInputElement>(
      '.edit-item-form input[type="text"]',
    )!;
    expect(labelInput.value).toBe('Heat');
    await act(async () => setFieldValue(labelInput, 'Heat (1995)'));
    await act(async () => buttonByText('Save').click());

    expect(stagedLabels()).toEqual(['Inception', 'Heat (1995)']);
    await act(async () => buttonByText('Add 2 items').click());
    expect(onAddMany).toHaveBeenCalledWith([
      expect.objectContaining({ label: 'Inception' }),
      expect.objectContaining({ label: 'Heat (1995)', id: canonicalKey('Heat (1995)') }),
    ]);
  });

  it('an edit that clears a collision updates the skip status', async () => {
    await renderMultiple({ existingIds: [canonicalKey('Heat')] });
    await paste('Heat');
    expect(statusFor('Heat')).toBe('already in sort');

    await act(async () => buttonByAria('Edit Heat').click());
    await act(async () =>
      setFieldValue(
        container.querySelector<HTMLInputElement>('.edit-item-form input[type="text"]')!,
        'Heat 2',
      ),
    );
    await act(async () => buttonByText('Save').click());

    expect(statusFor('Heat 2')).toBeNull();
  });

  it('shows duplicate warnings for repeated rows', async () => {
    await renderMultiple();
    await paste('Heat\nheat\nAlien');

    expect(stagedLabels()).toEqual(['Heat', 'Alien']);
    expect(container.querySelector('.add-items-staging .preview-warnings')?.textContent).toContain(
      'Warnings (1)',
    );
  });

  it('drops edits and removals when the pasted text changes', async () => {
    await renderMultiple();
    await paste('Inception\nHeat');
    await act(async () => buttonByAria('Remove Heat').click());
    expect(stagedLabels()).toEqual(['Inception']);

    await paste('Inception\nHeat\nAlien');
    expect(stagedLabels()).toEqual(['Inception', 'Heat', 'Alien']);
  });

  it('pre-ranked adds keep the staged order after edits', async () => {
    const { onAddPreRanked } = await renderMultiple();
    await paste('Inception\nHeat\nAlien');
    await act(async () => {
      container.querySelector<HTMLInputElement>('#multi-preranked')!.click();
    });
    await act(async () => buttonByAria('Remove Inception').click());
    await act(async () => buttonByText('Add 2 as pre-ranked sublist').click());

    expect(onAddPreRanked).toHaveBeenCalledWith([
      expect.objectContaining({ label: 'Heat' }),
      expect.objectContaining({ label: 'Alien' }),
    ]);
  });
});
