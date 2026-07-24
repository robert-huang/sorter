import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { _clearSpotifyApiBanForTesting, formatSpotifyApiBanMessage, setSpotifyApiBan } from '../../lib/spotify/spotifyApi';
import { useSpotifyApiBan } from '../useSpotifyApiBannedUntil';

let container: HTMLDivElement;
let root: Root;
let latestMessage: string | null = null;

function BanMessageProbe() {
  const ban = useSpotifyApiBan('playlist-items');
  latestMessage = ban ? formatSpotifyApiBanMessage(ban.bannedUntil) : null;
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  _clearSpotifyApiBanForTesting();
  latestMessage = null;
  vi.useRealTimers();
});

describe('useSpotifyApiBan', () => {
  it('re-renders the countdown each second while banned', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    setSpotifyApiBan('playlist-items', now + 86_000);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(<BanMessageProbe />);
    });
    expect(latestMessage).toBe('Spotify API rate limited — try again in 86s.');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(latestMessage).toBe('Spotify API rate limited — try again in 85s.');

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(latestMessage).toBe('Spotify API rate limited — try again in 80s.');
  });
});
