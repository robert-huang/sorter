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

function slot(id: string, done: boolean): SlotMeta {
  return {
    id,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    totalItems: 2,
    comparisons: 1,
    done,
  };
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
