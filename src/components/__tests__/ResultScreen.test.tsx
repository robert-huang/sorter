import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSort, seedAsDoneMerge } from '../../lib/queueMergeSort';
import type { Item, SortState, SortVersion } from '../../lib/types';
import { ConfirmSortConfirmModal } from '../ConfirmSortConfirmModal';
import { ResultScreen } from '../ResultScreen';

const A: Item = { id: 'a', label: 'A' };
const B: Item = { id: 'b', label: 'B' };

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

function resultProps(state: SortState, onConfirmSort = vi.fn()) {
  return {
    state,
    dbSyncRevision: 0,
    slotName: 'Favourites',
    slotId: 'slot-1',
    onUnhide: vi.fn(),
    onRestoreHidden: vi.fn(),
    onForgetHidden: vi.fn(),
    onStartOver: vi.fn(),
    onConfirmSort,
    onAddOne: vi.fn(),
    onAddMany: vi.fn(),
    onAddPreRanked: vi.fn(),
    onAddSlotImports: vi.fn(),
  };
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text,
  );
}

describe('ResultScreen Confirm sort entry point', () => {
  it('shows the completed-slot action with an explanatory tooltip', () => {
    const onConfirmSort = vi.fn();
    act(() => {
      root.render(
        <ResultScreen
          {...resultProps(seedAsDoneMerge([A, B]), onConfirmSort)}
        />,
      );
    });

    const button = buttonByText('Confirm sort');
    expect(button).toBeDefined();
    expect(button?.title).toContain('Start a new confirmation sort slot to verify this ranking from top to bottom');

    act(() => button?.click());
    expect(onConfirmSort).toHaveBeenCalledOnce();
  });

  it('does not show the action while the sort is unfinished', () => {
    act(() => {
      root.render(<ResultScreen {...resultProps(initSort([A, B]))} />);
    });

    expect(buttonByText('Confirm sort')).toBeUndefined();
  });

  it('keeps copied confirmations as status text', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.useFakeTimers();

    try {
      act(() => {
        root.render(<ResultScreen {...resultProps(seedAsDoneMerge([A, B]))} />);
      });
      const copyButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy as Markdown"]',
      );
      expect(copyButton?.textContent).toBe('Markdown');
      expect(copyButton?.querySelector('svg')).not.toBeNull();
      expect(copyButton).toBeDefined();

      await act(async () => {
        copyButton?.click();
      });

      expect(writeText).toHaveBeenCalledOnce();
      expect(copyButton?.textContent).toBe('✓ Copied');
      expect(copyButton?.querySelector('svg')).toBeNull();

      act(() => vi.runAllTimers());
    } finally {
      vi.useRealTimers();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: undefined,
        });
      }
    }
  });
});

describe('ConfirmSortConfirmModal', () => {
  it('explains the new confirmation slot and confirms', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmSortConfirmModal
          itemCount={2}
          slotName="Favourites"
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('Favourites (confirm)');
    expect(container.textContent).toContain('binary-inserted');
    const confirmButton = buttonByText('Create confirmation slot');
    act(() => confirmButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('can be cancelled without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmSortConfirmModal
          itemCount={2}
          slotName="Favourites"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      );
    });

    act(() => buttonByText('Cancel')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ResultScreen versions', () => {
  const C: Item = { id: 'c', label: 'C' };
  const versions: SortVersion[] = [
    {
      id: 'v1',
      createdAt: '2026-10-01T09:00:00',
      rankedIds: ['a', 'b'],
      items: { a: { label: 'A' }, b: { label: 'B' } },
    },
    {
      id: 'v2',
      createdAt: '2026-10-09T09:00:00',
      rankedIds: ['c', 'b', 'a'],
      items: { a: { label: 'A' }, b: { label: 'B' }, c: { label: 'C' } },
    },
  ];

  it('lists items removed since the previous version in the expanded ranking', () => {
    const withRemoval: SortVersion[] = [
      {
        id: 'v1',
        createdAt: '2026-10-01T09:00:00',
        rankedIds: ['a', 'd', 'b'],
        items: { a: { label: 'A' }, d: { label: 'Dropped' }, b: { label: 'B' } },
      },
      {
        id: 'v2',
        createdAt: '2026-10-09T09:00:00',
        rankedIds: ['a', 'b'],
        items: { a: { label: 'A' }, b: { label: 'B' } },
      },
    ];
    act(() => {
      root.render(
        <ResultScreen {...resultProps(seedAsDoneMerge([A, B]))} versions={withRemoval} />,
      );
    });
    act(() => buttonByText('Versions (2)')?.click());
    act(() =>
      document.querySelector<HTMLButtonElement>('.sort-versions-row .sort-versions-toggle')?.click(),
    );
    const removed = Array.from(
      document.querySelectorAll('.sort-version-removed .sort-version-ranking-row'),
      (row) => row.textContent,
    );
    expect(removed).toEqual(['2Droppedremoved']);
  });

  it('opens version history on right-click of Versions and explains it in the tooltip', () => {
    const onOpenVersionHistory = vi.fn();
    act(() => {
      root.render(
        <ResultScreen
          {...resultProps(seedAsDoneMerge([C, B, A]))}
          versions={versions}
          onOpenVersionHistory={onOpenVersionHistory}
        />,
      );
    });
    const button = buttonByText('Versions (2)')!;
    expect(button.title).toContain('Right-click to open version history');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(event);
    });
    expect(onOpenVersionHistory).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('.sort-versions-row')).toBeNull();
  });

  it('hides the Versions button when the save has no versions', () => {
    act(() => {
      root.render(<ResultScreen {...resultProps(seedAsDoneMerge([A, B]))} />);
    });
    expect(container.textContent).not.toContain('Versions (');
  });

  it('lists versions newest first, diffs each against its predecessor, and deletes', () => {
    const onDeleteVersion = vi.fn();
    act(() => {
      root.render(
        <ResultScreen
          {...resultProps(seedAsDoneMerge([C, B, A]))}
          versions={versions}
          onDeleteVersion={onDeleteVersion}
        />,
      );
    });
    act(() => buttonByText('Versions (2)')?.click());

    const rows = Array.from(document.querySelectorAll('.sort-versions-row'));
    expect(rows.map((row) => row.querySelector('.sort-versions-date')?.textContent)).toEqual([
      '2026-10-09 09:00',
      '2026-10-01 09:00',
    ]);
    expect(rows[0]?.querySelector('.sort-versions-summary')?.textContent).toBe(
      '1 added · A ↓2',
    );
    expect(rows[1]?.querySelector('.sort-versions-summary')?.textContent).toBe('First version');

    act(() => rows[0]?.querySelector<HTMLButtonElement>('.sort-versions-toggle')?.click());
    const ranking = Array.from(
      document.querySelectorAll('.sort-version-ranking-row'),
      (row) => row.textContent,
    );
    expect(ranking).toEqual(['1Cnew', '2B', '3A↓2']);

    expect(rows.every((row) => row.querySelector('.sort-versions-delete') !== null)).toBe(true);

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Delete version from 2026-10-01 09:00"]')
        ?.click(),
    );
    expect(onDeleteVersion).toHaveBeenCalledWith('v1');
  });
});
