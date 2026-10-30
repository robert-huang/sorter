import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaThemeSongRow } from '../../lib/importers/anilist/themeSongs/types';
import type { PlaylistMatchResult } from '../../lib/spotify/spotifyPlaylistMatch';
import type { ThemeSongPlaylistEditor } from '../../hooks/useThemeSongPlaylistEditor';
import { PLAYLIST_EDIT_FAILED_MS } from '../../hooks/usePlaylistEditAction';
import { ThemeSongPlaylistDot, ThemeSongRowC } from '../themeSongRowC';

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

async function renderDot(
  match: PlaylistMatchResult,
  marketUnavailable = false,
  spotifyCountry?: string,
): Promise<void> {
  await act(async () => {
    root.render(
      <ThemeSongPlaylistDot
        match={match}
        marketUnavailable={marketUnavailable}
        spotifyCountry={spotifyCountry}
      />,
    );
  });
}

describe('ThemeSongPlaylistDot', () => {
  it('uses an informational local-match dot with playlist metadata in its tooltip', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: {
        kind: 'local',
        track: {
          title: 'Houkiboshi (TV Size)',
          artists: ['Younha', 'ユンナ'],
          album: 'Bleach',
          durationMs: 89_000,
          playlistPosition: 17,
        },
      },
    });

    const dot = container.querySelector('.anilist-detail-theme-song-playlist-dot');
    expect(dot?.classList.contains('is-metadata')).toBe(true);
    expect(dot?.classList.contains('is-in')).toBe(false);
    expect(dot?.getAttribute('title')).toBe(
      'Matched playlist local file: \n\n#17 · Houkiboshi (TV Size) — Younha, ユンナ',
    );
    expect(dot?.getAttribute('aria-label')).toBe(dot?.getAttribute('title'));
  });

  it('identifies a catalog title/artist match in the blue-dot tooltip', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: {
        kind: 'spotify',
        track: {
          title: 'ウンディーネ',
          artists: ['Yui Makino'],
          album: 'ウンディーネ',
          durationMs: 345_426,
          playlistPosition: 1,
        },
      },
    });

    expect(container.querySelector('.is-metadata')?.getAttribute('title')).toBe(
      'Matched Spotify playlist track by title/artist: \n\n#1 · ウンディーネ — Yui Makino',
    );
  });

  it('shows the playlist position for exact matches', async () => {
    await renderDot({
      status: 'in',
      metadataMatch: null,
      playlistPosition: 3488,
    });
    expect(container.querySelector('.is-in')?.getAttribute('title')).toBe(
      'In your Spotify playlist at #3488',
    );
  });

  it('uses an orange dot for unavailable playlist matches', async () => {
    await renderDot(
      {
        status: 'in',
        metadataMatch: {
          kind: 'spotify',
          track: {
            title: 'Unavailable song',
            artists: ['Artist'],
            album: 'Album',
            durationMs: 180_000,
            playlistPosition: 17,
          },
        },
      },
      true,
      'CA',
    );

    const dot = container.querySelector('.is-market-unavailable');
    expect(dot?.getAttribute('title')).toBe(
      'In your Spotify playlist at #17, but unavailable in your market (CA)',
    );
    expect(container.querySelector('.is-metadata')).toBeNull();
    expect(container.querySelector('.is-in')).toBeNull();
  });

  it('keeps an unavailable local-file match blue', async () => {
    await renderDot(
      {
        status: 'in',
        metadataMatch: {
          kind: 'local',
          track: {
            title: `You've Got Friends ～あなたには友達がいる～`,
            artists: ['土屋太鳳'],
            album: 'Ai no Utagoe wo Kikasete',
            durationMs: 289_000,
            playlistPosition: 1855,
          },
        },
      },
      true,
      'TW',
    );

    const dot = container.querySelector('.is-metadata');
    expect(dot?.getAttribute('title')).toContain('#1855');
    expect(container.querySelector('.is-market-unavailable')).toBeNull();
  });

  it('preserves exact in/out indicators and leaves unknown rows without a dot', async () => {
    await renderDot({ status: 'in', metadataMatch: null });
    expect(container.querySelector('.is-in')?.getAttribute('title')).toBe(
      'In your Spotify playlist',
    );
    await renderDot({ status: 'out', metadataMatch: null });
    expect(container.querySelector('.is-out')?.getAttribute('title')).toBe(
      'Not in your Spotify playlist',
    );

    await renderDot({ status: 'unknown', metadataMatch: null });
    expect(container.querySelector('.anilist-detail-theme-song-playlist-dot')).toBeNull();
  });
});

describe('ThemeSongRowC', () => {
  it('uses a canonical spotify URL for existing cached theme songs', async () => {
    const row: MediaThemeSongRow = {
      type: 'Opening',
      sortOrder: 1,
      displayTitle: 'Track title',
      displayArtist: 'Artist',
      spotifyUrl:
        'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?utm_source=aniplaylist&utm_medium=website',
      spotifyTrackIds: ['3EXRwq9SPcToT8MfPAgRxN'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };

    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={row}
          playlistMatch={{ status: 'unknown', metadataMatch: null }}
          showPlaylistMatch={false}
        />,
      );
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://open.spotify.com/track/3EXRwq9SPcToT8MfPAgRxN?autoplay_ok=0',
    );
  });

  it('shows an orange dot when the selected link is unavailable in the account market', async () => {
    const row: MediaThemeSongRow = {
      type: 'Ending',
      sortOrder: 0,
      displayTitle: 'からっぽカプセル',
      displayArtist: 'Maaya Uchida',
      spotifyUrl: 'https://open.spotify.com/track/6V4ySJsF3NvRfr0XymF8NQ',
      spotifyAvailableMarkets: ['JP'],
      spotifyTrackIds: ['6V4ySJsF3NvRfr0XymF8NQ'],
      spotifyIsrc: null,
      hasResolvableTrackId: true,
    };

    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={row}
          playlistMatch={{ status: 'out', metadataMatch: null }}
          showPlaylistMatch={false}
          spotifyCountry="CA"
        />,
      );
    });

    expect(container.querySelector('.is-market-unavailable')?.getAttribute('title')).toBe(
      'On Spotify, but unavailable in your market (CA)',
    );
    expect(container.querySelector('.is-out')).toBeNull();
  });

  it('shows preview toggle when media context is provided', async () => {
    const row: MediaThemeSongRow = {
      type: 'Opening',
      sortOrder: 0,
      displayTitle: 'Grow Up',
      displayArtist: 'Hysteric Blue',
      spotifyUrl: null,
      spotifyTrackIds: [],
      spotifyIsrc: null,
      hasResolvableTrackId: false,
    };

    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={row}
          mediaId={1281}
          animeTitle="Ghost Stories"
          playlistMatch={{ status: 'unknown', metadataMatch: null }}
          showPlaylistMatch={false}
        />,
      );
    });

    expect(container.querySelector('.anilist-detail-theme-song-preview-toggle')).not.toBeNull();
  });
});

describe('ThemeSongRowC playlist edits', () => {
  const row: MediaThemeSongRow = {
    type: 'Opening',
    sortOrder: 1,
    displayTitle: 'Track title',
    displayArtist: 'Artist',
    spotifyUrl: null,
    spotifyTrackIds: ['AAAAAAAAAAAAAA'],
    spotifyIsrc: null,
    hasResolvableTrackId: true,
  };
  const OUT: PlaylistMatchResult = { status: 'out', metadataMatch: null };
  const IN: PlaylistMatchResult = { status: 'in', metadataMatch: null, playlistPosition: 4 };

  function editor(overrides: Partial<ThemeSongPlaylistEditor> = {}): ThemeSongPlaylistEditor {
    return {
      playlistName: 'Anime OPs',
      allowRemove: false,
      addRows: vi.fn(async () => {}),
      removeRow: vi.fn(async () => {}),
      ...overrides,
    };
  }

  async function renderRow(
    match: PlaylistMatchResult,
    playlistEditor: ThemeSongPlaylistEditor,
    spotifyCountry?: string,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <ThemeSongRowC
          row={{ ...row, spotifyAvailableMarkets: spotifyCountry ? ['JP'] : undefined }}
          playlistMatch={match}
          showPlaylistMatch
          spotifyCountry={spotifyCountry}
          playlistEditor={playlistEditor}
        />,
      );
    });
  }

  function dot(): HTMLElement {
    return container.querySelector('.anilist-detail-theme-song-playlist-dot') as HTMLElement;
  }

  function rightClick(shiftKey = false): void {
    dot().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey }));
  }

  it('adds a red song on right-click, spinning until the edit settles', async () => {
    let finish: () => void = () => {};
    const addRows = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const playlistEditor = editor({ addRows });
    await renderRow(OUT, playlistEditor);

    expect(dot().classList).toContain('is-addable');
    expect(dot().title).toBe('Not in your Spotify playlist\nRight-click to add to Anime OPs');

    act(() => rightClick());
    expect(addRows).toHaveBeenCalledWith([expect.objectContaining({ displayTitle: 'Track title' })]);
    expect(dot().classList).toContain('is-edit-busy');
    expect(dot().title).toBe('Adding to Anime OPs…');
    act(() => rightClick());
    expect(addRows).toHaveBeenCalledOnce();

    await act(async () => finish());
    await renderRow(IN, playlistEditor);
    expect(dot().classList).toContain('is-in');
    expect(dot().classList).not.toContain('is-edit-busy');
  });

  it('adds an orange song that is not on the playlist, but not one that already is', async () => {
    await renderRow(OUT, editor(), 'CA');
    expect(dot().classList).toContain('is-market-unavailable');
    expect(dot().classList).toContain('is-addable');

    await renderRow(IN, editor(), 'CA');
    expect(dot().classList).toContain('is-market-unavailable');
    expect(dot().classList).not.toContain('is-addable');
    expect(dot().classList).not.toContain('is-removable');
  });

  it('removes a green song only when removal is allowed', async () => {
    await renderRow(IN, editor());
    expect(dot().classList).not.toContain('is-removable');
    expect(dot().title).toBe('In your Spotify playlist at #4');

    const removeRow = vi.fn(async () => {});
    await renderRow(IN, editor({ allowRemove: true, removeRow }));
    expect(dot().classList).toContain('is-removable');
    expect(dot().title).toContain('Shift+right-click twice to remove from Anime OPs');
    await act(async () => rightClick());
    expect(dot().classList).not.toContain('is-remove-armed');
    await act(async () => rightClick(true));
    expect(removeRow).not.toHaveBeenCalled();
    expect(dot().classList).toContain('is-remove-armed');
    expect(dot().title).toBe('Shift+right-click again to remove from Anime OPs');
    await act(async () => rightClick(true));
    expect(removeRow).toHaveBeenCalledOnce();
  });

  it('disarms a pending remove when the pointer leaves the dot', async () => {
    const removeRow = vi.fn(async () => {});
    await renderRow(IN, editor({ allowRemove: true, removeRow }));
    await act(async () => rightClick(true));
    expect(dot().classList).toContain('is-remove-armed');

    act(() => {
      dot().dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(dot().classList).not.toContain('is-remove-armed');
    await act(async () => rightClick(true));
    expect(removeRow).not.toHaveBeenCalled();
  });

  it('shows an x on failure, then returns to the dot with the error kept in the tooltip', async () => {
    vi.useFakeTimers();
    try {
      await renderRow(OUT, editor({ addRows: vi.fn(async () => Promise.reject(new Error('nope'))) }));
      await act(async () => rightClick());

      expect(dot().classList).toContain('is-edit-failed');
      expect(dot().textContent).toBe('✕');
      expect(dot().title).toContain("Couldn't add: nope");

      act(() => vi.advanceTimersByTime(PLAYLIST_EDIT_FAILED_MS));
      expect(dot().classList).toContain('is-out');
      expect(dot().textContent).toBe('');
      expect(dot().title).toContain("Couldn't add: nope");
    } finally {
      vi.useRealTimers();
    }
  });
});
