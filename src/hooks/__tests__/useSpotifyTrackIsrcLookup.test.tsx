import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaThemeSongRow } from '../../lib/importers/anilist/themeSongs/types';
import { ensureSpotifyAccessToken } from '../../lib/spotify/spotifyAuth';
import { ensureTrackIsrcsCached } from '../../lib/spotify/spotifyTrackIsrcStore';
import { useSpotifyTrackIsrcLookup } from '../useSpotifyTrackIsrcLookup';

vi.mock('../../lib/spotify/spotifyAuth', () => ({
  ensureSpotifyAccessToken: vi.fn(async () => null),
  ensureSpotifyAccountCountry: vi.fn(async () => null),
  getStoredSpotifyAuth: vi.fn(() => null),
  subscribeSpotifyAuth: vi.fn(() => () => undefined),
}));

vi.mock('../../lib/spotify/spotifyTrackIsrcStore', () => ({
  ensureTrackIsrcsCached: vi.fn(),
  getTrackIsrcStoreSnapshot: vi.fn(() => new Map()),
}));

function makeRow(trackIds: string[]): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 1,
    displayTitle: 'Test',
    displayArtist: null,
    spotifyUrl: null,
    spotifyTrackIds: trackIds,
    spotifyIsrc: null,
    hasResolvableTrackId: trackIds.length > 0,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.clearAllMocks();
});

describe('useSpotifyTrackIsrcLookup', () => {
  it('does not loop when callers pass a fresh empty array each render', () => {
    function Probe(): null {
      useSpotifyTrackIsrcLookup([]);
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(<Probe />);
    });
    act(() => {
      root.render(<Probe />);
    });
    act(() => {
      root.render(<Probe />);
    });

    expect(vi.mocked(ensureSpotifyAccessToken)).not.toHaveBeenCalled();
  });

  it('treats different empty array instances as the same track-id key', () => {
    let readyAfterSecondRender = false;

    function Probe({ rows }: { rows: readonly MediaThemeSongRow[] }): null {
      const { ready } = useSpotifyTrackIsrcLookup(rows);
      if (rows.length === 0 && ready) {
        readyAfterSecondRender = true;
      }
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(<Probe rows={[]} />);
    });
    act(() => {
      root.render(<Probe rows={[]} />);
    });

    expect(readyAfterSecondRender).toBe(true);
  });

  it('checks Spotify once per distinct track-id set', async () => {
    function Probe({ rows }: { rows: readonly MediaThemeSongRow[] }): null {
      useSpotifyTrackIsrcLookup(rows);
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Probe rows={[makeRow(['track-a'])]} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Probe rows={[makeRow(['track-b'])]} />);
      await Promise.resolve();
    });

    expect(vi.mocked(ensureSpotifyAccessToken)).toHaveBeenCalledTimes(2);
  });

  it('does not show a misleading zero counter while the local ISRC cache hydrates', async () => {
    let finishLookup: (() => void) | null = null;
    vi.mocked(ensureSpotifyAccessToken).mockResolvedValue('token');
    vi.mocked(ensureTrackIsrcsCached).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishLookup = resolve;
      });
      return new Map();
    });

    function Probe() {
      const { ready, progress } = useSpotifyTrackIsrcLookup([
        makeRow(['track-a', 'track-b']),
      ]);
      let label = 'ready';
      if (!ready) {
        label =
          progress === null
            ? 'hydrating'
            : `${progress.completed}/${progress.total}`;
      }
      return <div>{label}</div>;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe('hydrating');

    await act(async () => {
      finishLookup?.();
      await Promise.resolve();
    });

    expect(container.textContent).toBe('ready');
  });

  it('exposes completed and total track lookups while cached songs load', async () => {
    let finishLookup: (() => void) | null = null;
    vi.mocked(ensureSpotifyAccessToken).mockResolvedValue('token');
    vi.mocked(ensureTrackIsrcsCached).mockImplementation(
      async (_trackIds, _token, onProgress) => {
        onProgress?.({ completed: 2, total: 4 });
        await new Promise<void>((resolve) => {
          finishLookup = resolve;
        });
        return new Map();
      },
    );

    function Probe() {
      const { ready, progress } = useSpotifyTrackIsrcLookup([
        makeRow(['track-a', 'track-b', 'track-c', 'track-d']),
      ]);
      return (
        <div>
          {ready || progress === null
            ? 'ready'
            : `${progress.completed}/${progress.total}`}
        </div>
      );
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toBe('2/4');

    await act(async () => {
      finishLookup?.();
      await Promise.resolve();
    });

    expect(container.textContent).toBe('ready');
  });
});
