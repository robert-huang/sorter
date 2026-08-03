import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlotMeta } from '../../lib/types';
import { SlotList } from '../SlotList';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function slot(
  id: string,
  done: boolean,
  overrides: Partial<SlotMeta> = {},
): SlotMeta {
  return {
    id,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    totalItems: 2,
    comparisons: 1,
    done,
    ...overrides,
  };
}

async function renderSlotList(
  slots: SlotMeta[],
  cloudControlsVisible = false,
): Promise<void> {
  const noop = vi.fn();
  await act(async () => {
    root.render(
      <SlotList
        slots={slots}
        loadedSlotId={null}
        onSwitch={noop}
        onDelete={noop}
        onRename={noop}
        onDownload={noop}
        onTogglePin={noop}
        cloudControlsVisible={cloudControlsVisible}
        onCloudToggleOptIn={noop}
        onCloudPush={noop}
        onCloudPull={noop}
        cloudPushingIds={new Set()}
        cloudPullingIds={new Set()}
      />,
    );
  });
}

describe('SlotList metadata classes', () => {
  it('marks only completed slot metadata rows as done', async () => {
    const noop = vi.fn();
    await act(async () => {
      root.render(
        <SlotList
          slots={[slot('complete', true), slot('active', false)]}
          loadedSlotId="active"
          onSwitch={noop}
          onDelete={noop}
          onRename={noop}
          onDownload={noop}
          onTogglePin={noop}
          cloudControlsVisible={false}
          onCloudToggleOptIn={noop}
          onCloudPush={noop}
          onCloudPull={noop}
          cloudPushingIds={new Set()}
          cloudPullingIds={new Set()}
        />,
      );
    });

    const metadata = Array.from(container.querySelectorAll('.slot-meta'));
    expect(metadata).toHaveLength(2);
    expect(metadata[0]?.classList.contains('slot-meta--done')).toBe(true);
    expect(metadata[1]?.classList.contains('slot-meta--done')).toBe(false);
  });
});

describe('SlotList status icons', () => {
  it('puts the reusable pin icon before pinned slot names and metadata', async () => {
    await renderSlotList([
      slot('Pinned sort', false, {
        pinned: true,
        totalItems: 332,
        comparisons: 733,
      }),
      slot('Unpinned sort', false),
    ]);

    const rows = Array.from(container.querySelectorAll('.slot-row'));
    const pinnedRow = rows.find(
      (row) => row.querySelector('.slot-name')?.textContent === 'Pinned sort',
    );
    const unpinnedRow = rows.find(
      (row) => row.querySelector('.slot-name')?.textContent === 'Unpinned sort',
    );
    const nameRow = pinnedRow?.querySelector('.slot-name-row');
    const metadata = pinnedRow?.querySelector('.slot-meta');

    expect(nameRow?.firstElementChild?.matches('svg.pin-icon')).toBe(true);
    expect(pinnedRow?.querySelectorAll('.pin-icon')).toHaveLength(1);
    expect(metadata?.textContent).toContain('332 items · 733 comparisons');
    expect(metadata?.textContent).not.toContain('pinned');
    expect(unpinnedRow?.querySelector('.pin-icon')).toBeNull();
  });

  it('wraps the cloud glyph in its alignment class', async () => {
    await renderSlotList([slot('Cloud sort', false)], true);

    const cloudIcon = container.querySelector('.cloud-icon');
    expect(cloudIcon?.textContent?.trim()).toBe('☁');
    expect(cloudIcon?.parentElement?.classList.contains('icon-button')).toBe(true);
  });
});
