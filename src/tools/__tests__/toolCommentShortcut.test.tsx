import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleToolCommentShortcut } from '../toolLineComments';

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
  vi.restoreAllMocks();
});

function Harness({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return (
    <textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => handleToolCommentShortcut(e, setText)}
    />
  );
}

function press(el: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

function setPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

describe('Ctrl/⌘+/ in a tool textarea', () => {
  it('toggles the caret line with Ctrl+/ off macOS', () => {
    setPlatform('Win32');
    act(() => root.render(<Harness initial={'Heat\nAlien'} />));
    const el = container.querySelector('textarea')!;
    el.setSelectionRange(7, 7);

    const event = press(el, { key: '/', code: 'Slash', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe('Heat\n// Alien');

    press(el, { key: '/', code: 'Slash', ctrlKey: true });
    expect(el.value).toBe('Heat\nAlien');
  });

  it('uses ⌘+/ on macOS and ignores Ctrl+/ there', () => {
    setPlatform('MacIntel');
    act(() => root.render(<Harness initial="Heat" />));
    const el = container.querySelector('textarea')!;
    el.setSelectionRange(0, 0);

    expect(press(el, { key: '/', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(el.value).toBe('Heat');
    press(el, { key: '/', metaKey: true });
    expect(el.value).toBe('// Heat');
  });

  it('leaves plain / and other shortcuts alone', () => {
    setPlatform('Win32');
    act(() => root.render(<Harness initial="Heat" />));
    const el = container.querySelector('textarea')!;
    expect(press(el, { key: '/' }).defaultPrevented).toBe(false);
    expect(press(el, { key: '/', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(press(el, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(el.value).toBe('Heat');
  });
});
