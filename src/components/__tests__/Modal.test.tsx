import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Modal } from '../Modal';

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

async function flushFocus(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('Modal Escape handling', () => {
  it('closes a single modal with Escape', async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal label="Only modal" onClose={onClose}>
          Content
        </Modal>,
      );
    });
    await flushFocus();

    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Only modal"]',
    );
    expect(dialog).not.toBeNull();

    act(() => {
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the top layer when focus is stale in the bottom layer', async () => {
    const closeBottom = vi.fn();
    const closeTop = vi.fn();
    act(() => {
      root.render(
        <>
          <Modal
            label="Bottom modal"
            onClose={closeBottom}
            stackIndex={0}
            isTopmost={false}
          >
            Bottom
          </Modal>
          <Modal label="Top modal" onClose={closeTop} stackIndex={1}>
            Top
          </Modal>
        </>,
      );
    });
    await flushFocus();

    const bottomDialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Bottom modal"]',
    );
    const topDialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Top modal"]',
    );
    expect(bottomDialog?.parentElement?.style.zIndex).toBe('100');
    expect(bottomDialog?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(topDialog?.parentElement?.style.zIndex).toBe('101');
    expect(document.activeElement).toBe(topDialog);

    act(() => {
      bottomDialog?.focus();
      bottomDialog?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeBottom).not.toHaveBeenCalled();
  });

  it('moves focus when an existing bottom modal is promoted to the top', async () => {
    const closeMedia = vi.fn();
    const closeStaff = vi.fn();
    act(() => {
      root.render(
        <>
          <Modal
            key="media-1"
            label="Media modal"
            onClose={closeMedia}
            stackIndex={0}
            isTopmost={false}
          >
            Media
          </Modal>
          <Modal key="staff-1" label="Staff modal" onClose={closeStaff} stackIndex={1}>
            Staff
          </Modal>
        </>,
      );
    });
    await flushFocus();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Staff modal');

    act(() => {
      root.render(
        <>
          <Modal
            key="staff-1"
            label="Staff modal"
            onClose={closeStaff}
            stackIndex={0}
            isTopmost={false}
          >
            Staff
          </Modal>
          <Modal key="media-1" label="Media modal" onClose={closeMedia} stackIndex={1}>
            Media
          </Modal>
        </>,
      );
    });
    await flushFocus();

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Media modal');
  });
});
