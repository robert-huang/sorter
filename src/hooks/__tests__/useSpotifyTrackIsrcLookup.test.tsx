import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaThemeSongRow } from '../../lib/importers/anilist/themeSongs/types';
import { ensureSpotifyAccessToken } from '../../lib/spotify/spotifyAuth';
import { useSpotifyTrackIsrcLookup } from '../useSpotifyTrackIsrcLookup';

vi.mock('../../lib/spotify/spotifyAuth', () => ({
  ensureSpotifyAccessToken: vi.fn(async () => null),
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
});
