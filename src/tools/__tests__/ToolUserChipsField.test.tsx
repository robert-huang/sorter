import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolUserChipsField } from '../ToolUserChipsField';
import {
  TOOL_USER_HISTORY_LS_KEY,
  forgetToolUser,
  loadToolUserHistory,
  rememberToolUser,
  suggestToolUsers,
} from '../toolUserHistory';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderField(usernames: string[] = [], onAdd = vi.fn()) {
  act(() => {
    root.render(
      <ToolUserChipsField
        inputName="test-user"
        usernames={usernames}
        isLoading={() => false}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
  });
  return onAdd;
}

const input = () => container.querySelector<HTMLInputElement>('input[name="test-user"]')!;
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((el) => el.textContent);

function type(value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  });
}

function focus(): void {
  act(() => input().focus());
}

describe('toolUserHistory', () => {
  it('keeps the most recent first and dedupes case-insensitively', () => {
    rememberToolUser('alice');
    rememberToolUser('bob');
    rememberToolUser('Alice');
    expect(loadToolUserHistory()).toEqual(['Alice', 'bob']);
    expect(forgetToolUser('ALICE')).toEqual(['bob']);
  });

  it('ignores malformed storage', () => {
    localStorage.setItem(TOOL_USER_HISTORY_LS_KEY, '{"nope":1}');
    expect(loadToolUserHistory()).toEqual([]);
  });

  it('filters by substring and drops users already added', () => {
    expect(suggestToolUsers(['alice', 'malik', 'bob'], 'LI', ['Malik'])).toEqual(['alice']);
  });
});

describe('ToolUserChipsField history dropdown', () => {
  it('records added users and suggests them on focus, minus current chips', () => {
    const onAdd = renderField();
    type('alice');
    key('Enter');
    expect(onAdd).toHaveBeenCalledWith('alice');
    expect(loadToolUserHistory()).toEqual(['alice']);

    rememberToolUser('bob');
    renderField(['alice']);
    act(() => input().blur());
    focus();
    expect(options()).toEqual(['bob']);
  });

  it('adds the highlighted suggestion with arrow keys and Enter', () => {
    rememberToolUser('bob');
    rememberToolUser('carol');
    const onAdd = renderField();
    focus();
    expect(options()).toEqual(['carol', 'bob']);
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(onAdd).toHaveBeenCalledWith('bob');
  });

  it('forgets the highlighted suggestion with Shift+Delete', () => {
    rememberToolUser('bob');
    rememberToolUser('carol');
    const onAdd = renderField();
    focus();
    key('ArrowDown');
    key('Delete');
    expect(options()).toEqual(['carol', 'bob']);
    key('Delete', { shiftKey: true });
    expect(options()).toEqual(['bob']);
    expect(loadToolUserHistory()).toEqual(['bob']);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('narrows suggestions as the user types and closes on Escape', () => {
    rememberToolUser('alice');
    rememberToolUser('bob');
    renderField();
    focus();
    type('al');
    expect(options()).toEqual(['alice']);
    key('Escape');
    expect(options()).toEqual([]);
  });
});
