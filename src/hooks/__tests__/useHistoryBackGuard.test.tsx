import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryBackGuard } from '../useHistoryBackGuard';

function Harness({
  enabled,
  onBack,
}: {
  enabled: boolean;
  onBack?: () => void;
}): null {
  useHistoryBackGuard(enabled, onBack);
  return null;
}

describe('useHistoryBackGuard', () => {
  const pushState = vi.fn();
  const back = vi.fn();
  let popstateHandler: (() => void) | null = null;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    popstateHandler = null;
    pushState.mockClear();
    back.mockClear();
    vi.stubGlobal('history', {
      pushState,
      back,
    });
    vi.stubGlobal('addEventListener', vi.fn((type: string, handler: () => void) => {
      if (type === 'popstate') popstateHandler = handler;
    }));
    vi.stubGlobal('removeEventListener', vi.fn());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('pushes a sentinel when enabled', () => {
    act(() => {
      root.render(createElement(Harness, { enabled: true }));
    });
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('does not push when disabled', () => {
    act(() => {
      root.render(createElement(Harness, { enabled: false }));
    });
    expect(pushState).not.toHaveBeenCalled();
  });

  it('calls onBack and re-pushes on popstate', () => {
    const onBack = vi.fn();
    act(() => {
      root.render(createElement(Harness, { enabled: true, onBack }));
    });
    expect(popstateHandler).not.toBeNull();
    act(() => {
      popstateHandler?.();
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledTimes(2);
  });

  it('pops the sentinel on cleanup', () => {
    act(() => {
      root.render(createElement(Harness, { enabled: true }));
    });
    act(() => {
      root.unmount();
    });
    expect(back).toHaveBeenCalledTimes(1);
  });
});
