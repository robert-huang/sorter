import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTimeField } from '../DateTimeField';

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

function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function render(onChange: (value: string) => void): void {
  act(() => {
    root.render(<DateTimeField label="Date" value="2026-01-05T14:30" onChange={onChange} />);
  });
}

function openEditor(): HTMLInputElement {
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Edit Date"]')!.click());
  return container.querySelector<HTMLInputElement>('[aria-label="Date text"]')!;
}

function pressKey(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('DateTimeField', () => {
  it('shows the value as text and edits it with a picker underneath', () => {
    render(vi.fn());
    expect(container.querySelector('[aria-label="Edit Date"]')?.textContent).toBe(
      '2026-01-05 14:30',
    );
    const text = openEditor();
    expect(text.value).toBe('2026-01-05 14:30');
    expect(container.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.value).toBe(
      '2026-01-05T14:30',
    );
  });

  it('saves a typed date alone as midnight', () => {
    const onChange = vi.fn();
    render(onChange);
    const text = openEditor();
    act(() => setValue(text, '2026-02-15'));
    pressKey(text, 'Enter');
    expect(onChange).toHaveBeenCalledWith('2026-02-15T00:00');
    expect(container.querySelector('[aria-label="Date text"]')).toBeNull();
  });

  it('does not save text that is not a valid date/time', () => {
    const onChange = vi.fn();
    render(onChange);
    const text = openEditor();
    act(() => setValue(text, '2026-02-30'));
    expect(text.getAttribute('aria-invalid')).toBe('true');
    pressKey(text, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('discards the edit on Escape', () => {
    const onChange = vi.fn();
    render(onChange);
    const text = openEditor();
    act(() => setValue(text, '2027-01-01'));
    pressKey(text, 'Escape');
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Edit Date"]')).not.toBeNull();
  });

  it('saves a value chosen in the picker', () => {
    const onChange = vi.fn();
    render(onChange);
    openEditor();
    const picker = container.querySelector<HTMLInputElement>('[aria-label="Date"]')!;
    act(() => setValue(picker, '2026-03-01T08:15'));
    expect(onChange).toHaveBeenCalledWith('2026-03-01T08:15');
  });
});
