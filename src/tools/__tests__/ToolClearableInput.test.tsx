import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolClearableInput } from '../ToolClearableInput';

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

describe('ToolClearableInput', () => {
  it('uses the shared remove SVG for the clear action', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <ToolClearableInput id="query" value="value" onChange={onChange} />,
      );
    });

    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear field"]',
    );
    expect(
      clearButton?.querySelector('svg.icon-btn-glyph.tool-clearable-input-icon'),
    ).not.toBeNull();
    expect(clearButton?.textContent).not.toContain('×');

    act(() => clearButton?.click());
    expect(onChange).toHaveBeenCalledWith('');
  });
});
