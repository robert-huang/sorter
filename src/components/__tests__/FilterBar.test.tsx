/**
 * Phase D: FilterBar shell behavior — partition by source.kind, delegate
 * chip rendering + computeAllowed to the per-source FilterModule, union
 * the allowed externalIds back into visibleIds emitted upward.
 *
 * Uses a stub SourceFilterModule registered for 'anilist' to exercise
 * the delegation path without pulling the real AniList SQLite code into
 * the test (the real chip module is covered separately in
 * filters.test.ts).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearSourceFiltersForTesting,
  registerSourceFilters,
  type FilterChipState,
  type SourceFilterModule,
} from '../../lib/db/source-registry';
import type { Item, ItemId } from '../../lib/types';
import { FilterBar } from '../FilterBar';

// ---------------------------------------------------------------------
// jsdom root harness (no react-testing-library — keep dep surface flat)
// ---------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 18 expects test harnesses to opt-in to act()'s no-warning
  // mode via this global flag. Without it, every act() call emits a
  // noisy "current testing environment is not configured" warning.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  _clearSourceFiltersForTesting();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  // Two-stage flush: the FilterBar effect kicks off an async computeAllowed,
  // so we need a microtask drain after React commits. await-ing the
  // outer act() drains the commit; the second await covers the
  // computeAllowed Promise's microtask.
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------
// Stub source module — minimal, deterministic, no DB.
// ---------------------------------------------------------------------

interface StubChipState extends FilterChipState {
  activeIds: number[];
}

// Shared reference for the initial state — the FilterBar's "no chips
// active" fast path uses shallow `===` equality on each key, so a fresh
// `[]` per call would always look "active". The real AniList module
// avoids this in practice by using `computeAllowedMediaIds` to do a
// deep check before the SQL round-trip; the stub here keeps the
// reference stable so the fast path is exercised cleanly.
const INITIAL_STUB_STATE: StubChipState = { activeIds: [] };

function makeStubModule(computeAllowed: SourceFilterModule['computeAllowed']) {
  return {
    initialChipState: (): StubChipState => INITIAL_STUB_STATE,
    renderChips: ({ chipState, onChipStateChange }) => {
      // A single button that flips the chip state from "all off" to
      // "only ids [2]" — gives the tests a deterministic way to
      // transition out of the fast path.
      return (
        <button
          data-testid="stub-toggle"
          type="button"
          onClick={() => onChipStateChange({ activeIds: [2] })}
        >
          {(chipState as StubChipState).activeIds.length === 0
            ? 'off'
            : 'on'}
        </button>
      );
    },
    computeAllowed,
  } satisfies SourceFilterModule;
}

function makeItem(
  id: ItemId,
  source?: { kind: 'anilist'; externalId: number },
): Item {
  return source
    ? { id, label: `item-${id}`, source }
    : { id, label: `item-${id}` };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('FilterBar', () => {
  it('emits null (all visible) on first render when no chips are active', async () => {
    registerSourceFilters(
      'anilist',
      makeStubModule(async () => new Set([1, 2, 3])),
    );
    const items = [makeItem('A' as ItemId, { kind: 'anilist', externalId: 1 })];
    const onVisible = vi.fn();
    await act(async () => {
      root.render(<FilterBar items={items} onVisibleChange={onVisible} />);
    });
    await flush();
    expect(onVisible).toHaveBeenCalledWith(null);
  });

  it('renders nothing when only manual items are present (no chip module hit)', async () => {
    const items = [makeItem('A' as ItemId), makeItem('B' as ItemId)];
    const onVisible = vi.fn();
    await act(async () => {
      root.render(<FilterBar items={items} onVisibleChange={onVisible} />);
    });
    await flush();
    expect(container.querySelector('.filter-bar')).toBeNull();
    // Fast path still fires the all-visible signal for downstream consumers.
    expect(onVisible).toHaveBeenCalledWith(null);
  });

  it('passes manual items through unconditionally even when an AniList chip is active', async () => {
    // Stub module: only externalId=2 passes when active.
    const computeAllowed: SourceFilterModule['computeAllowed'] = vi.fn(
      async (_externalIds, state) =>
        new Set<string | number>((state as StubChipState).activeIds),
    );
    registerSourceFilters('anilist', makeStubModule(computeAllowed));

    const items: Item[] = [
      makeItem('manualA' as ItemId),
      makeItem('anilist1' as ItemId, { kind: 'anilist', externalId: 1 }),
      makeItem('anilist2' as ItemId, { kind: 'anilist', externalId: 2 }),
    ];
    const onVisible = vi.fn();
    await act(async () => {
      root.render(<FilterBar items={items} onVisibleChange={onVisible} />);
    });
    await flush();
    // Initial fast-path emit.
    expect(onVisible).toHaveBeenLastCalledWith(null);

    // Flip the chip state out of the initial — this triggers the async
    // computeAllowed path and a fresh emit.
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="stub-toggle"]');
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    await flush();

    expect(vi.mocked(computeAllowed)).toHaveBeenCalled();
    const calls = onVisible.mock.calls;
    const lastCall = calls[calls.length - 1];
    const visible = lastCall[0] as Set<ItemId>;
    // Manual item always visible.
    expect(visible.has('manualA' as ItemId)).toBe(true);
    // AniList externalId=1 filtered out, externalId=2 allowed.
    expect(visible.has('anilist1' as ItemId)).toBe(false);
    expect(visible.has('anilist2' as ItemId)).toBe(true);
  });

  it('passes the slot\u2019s externalIds (not the full universe) to computeAllowed', async () => {
    const computeAllowed: SourceFilterModule['computeAllowed'] = vi.fn(
      async () => new Set<string | number>([1]),
    );
    registerSourceFilters('anilist', makeStubModule(computeAllowed));

    const items: Item[] = [
      makeItem('a' as ItemId, { kind: 'anilist', externalId: 1 }),
      makeItem('b' as ItemId, { kind: 'anilist', externalId: 5 }),
      makeItem('c' as ItemId, { kind: 'anilist', externalId: 9 }),
    ];
    await act(async () => {
      root.render(<FilterBar items={items} onVisibleChange={vi.fn()} />);
    });
    await flush();
    // Activate the stub to fire computeAllowed.
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="stub-toggle"]');
    await act(async () => {
      btn!.click();
    });
    await flush();

    const computeMock = vi.mocked(computeAllowed);
    expect(computeMock).toHaveBeenCalled();
    const allCalls = computeMock.mock.calls;
    const passedExternalIds = allCalls[allCalls.length - 1][0];
    expect(Array.from(passedExternalIds).sort()).toEqual([1, 5, 9]);
  });

  it('drops the AniList bucket entirely when no module is registered (graceful skip)', async () => {
    // No registerSourceFilters call -> getSourceFilters returns null
    // for 'anilist'. The bar should treat those items as having no
    // filterable controls (renders nothing, all visible).
    const items: Item[] = [
      makeItem('a' as ItemId, { kind: 'anilist', externalId: 1 }),
    ];
    const onVisible = vi.fn();
    await act(async () => {
      root.render(<FilterBar items={items} onVisibleChange={onVisible} />);
    });
    await flush();
    expect(container.querySelector('.filter-bar')).toBeNull();
    expect(onVisible).toHaveBeenCalledWith(null);
  });
});
