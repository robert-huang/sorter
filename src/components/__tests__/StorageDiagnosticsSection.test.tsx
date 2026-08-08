import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageDiagnosticsSection } from '../StorageDiagnosticsSection';

const diagnosticsMocks = vi.hoisted(() => ({
  collect: vi.fn(),
  clearAll: vi.fn(),
  clearImages: vi.fn(),
  clearSpotify: vi.fn(),
  clearTools: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('../../lib/storageDiagnostics', () => ({
  collectStorageDiagnostics: diagnosticsMocks.collect,
  clearEveryDisposableCache: diagnosticsMocks.clearAll,
  clearImageCaches: diagnosticsMocks.clearImages,
  clearSpotifyCaches: diagnosticsMocks.clearSpotify,
  clearToolsApiCaches: diagnosticsMocks.clearTools,
  requestPersistentStorage: diagnosticsMocks.persist,
}));

let container: HTMLDivElement;
let root: Root;

const diagnostics = {
  collectedAt: 1,
  usage: 75,
  quota: 100,
  persisted: false,
  localStorage: [{ owner: 'settings', entries: 2, bytes: 100 }],
  stores: [{ id: 'cache:tools', label: 'Tools API cache', entries: 3, bytes: 200 }],
  lastCleanupError: null,
  lastQuotaErrorAt: null,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  diagnosticsMocks.collect.mockReset().mockResolvedValue(diagnostics);
  diagnosticsMocks.clearAll.mockReset().mockResolvedValue(undefined);
  diagnosticsMocks.clearImages.mockReset().mockResolvedValue(undefined);
  diagnosticsMocks.clearSpotify.mockReset().mockResolvedValue(undefined);
  diagnosticsMocks.clearTools.mockReset().mockResolvedValue(undefined);
  diagnosticsMocks.persist.mockReset().mockResolvedValue(true);
  vi.stubGlobal('navigator', {
    ...navigator,
    storage: {
      estimate: vi.fn(async () => ({ usage: 75, quota: 100 })),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<StorageDiagnosticsSection />);
  });
}

async function openDiagnostics(): Promise<void> {
  const details = container.querySelector('details');
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error('Missing diagnostics details element.');
  }
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle', { bubbles: true }));
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe('StorageDiagnosticsSection', () => {
  it('is collapsed by default and defers detailed collection until opened', async () => {
    await render();

    expect(container.querySelector('details')?.open).toBe(false);
    expect(diagnosticsMocks.collect).not.toHaveBeenCalled();

    await openDiagnostics();

    expect(diagnosticsMocks.collect).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Tools API cache');
    expect(container.textContent).toContain('75.0%');
    expect(container.querySelector('dt')?.title).toContain(
      'storage used by this site',
    );
    expect(button('Clear image cache').classList).toContain('small');
    expect(button('Clear image cache').title).toContain(
      'Bump Chart export image files',
    );
  });

  it('shows a storage-pressure warning outside the collapsed details', async () => {
    await render();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector('.storage-pressure--warning')).not.toBeNull();
    expect(diagnosticsMocks.collect).not.toHaveBeenCalled();
  });

  it('marks storage pressure as critical at 85 percent', async () => {
    vi.mocked(navigator.storage.estimate).mockResolvedValue({
      usage: 85,
      quota: 100,
    });
    await render();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector('.storage-pressure--critical')).not.toBeNull();
  });

  it('runs only disposable-cache actions and refreshes their measurements', async () => {
    await render();
    await openDiagnostics();
    diagnosticsMocks.collect.mockClear();

    await act(async () => {
      button('Clear all disposable caches').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(diagnosticsMocks.clearAll).toHaveBeenCalledOnce();
    expect(diagnosticsMocks.collect).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Disposable caches cleared.');
  });

  it('maps each cache button to its matching disposable cache', async () => {
    await render();
    await openDiagnostics();

    const actions: Array<[string, ReturnType<typeof vi.fn>]> = [
      ['Clear tools/API cache', diagnosticsMocks.clearTools],
      ['Clear Spotify caches', diagnosticsMocks.clearSpotify],
      ['Clear image cache', diagnosticsMocks.clearImages],
    ];
    for (const [label, action] of actions) {
      await act(async () => {
        button(label).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(action).toHaveBeenCalledOnce();
    }
  });

  it('shows immediate feedback and explains an automatic persistence denial', async () => {
    let resolvePersistence: (value: boolean | null) => void = () => {};
    diagnosticsMocks.persist.mockReturnValueOnce(
      new Promise<boolean | null>((resolve) => {
        resolvePersistence = resolve;
      }),
    );
    await render();
    await openDiagnostics();

    act(() => {
      button('Request persistent storage').click();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Requesting persistent storage',
    );

    await act(async () => {
      resolvePersistence(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(diagnosticsMocks.persist).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Browsers decide automatically and usually do not show a prompt',
    );
    expect(button('Request persistent storage').disabled).toBe(false);
  });
});
