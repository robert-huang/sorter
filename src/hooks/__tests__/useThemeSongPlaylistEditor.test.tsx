import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaThemeSongRow } from '../../lib/importers/anilist/themeSongs/types';
import type { CachedPlaylistTrack, SpotifyPlaylistCache } from '../../lib/spotify/spotifyPlaylist';
import {
  _clearToolsPreferencesForTesting,
  loadToolsPreferences,
  saveToolsPreferences,
} from '../../tools/toolsPreferences';
import { useThemeSongPlaylistEditor, type ThemeSongPlaylistEditor } from '../useThemeSongPlaylistEditor';

const mocks = vi.hoisted(() => ({
  cache: null as SpotifyPlaylistCache | null,
  insert: vi.fn(async () => {}),
}));

vi.mock('../../lib/spotify/spotifyPlaylist', () => ({
  getPlaylistCache: () => mocks.cache,
  getSelectedSpotifyPlaylist: () => ({ id: 'pl', name: 'Anime OPs' }),
  subscribeSpotifyPlaylist: () => () => {},
}));
vi.mock('../../lib/spotify/spotifyAuth', () => ({
  getStoredSpotifyAuth: () => ({ accessToken: 't' }),
  subscribeSpotifyAuth: () => () => {},
}));
vi.mock('../../lib/spotify/spotifyPlaylistEdits', () => ({
  insertTracksIntoSelectedPlaylist: mocks.insert,
  removeTrackFromSelectedPlaylist: vi.fn(),
}));

function makeRow(overrides: Partial<MediaThemeSongRow>): MediaThemeSongRow {
  return {
    type: 'Opening',
    sortOrder: 0,
    displayTitle: 'Song',
    displayArtist: null,
    spotifyUrl: null,
    spotifyTrackIds: [],
    spotifyIsrc: null,
    hasResolvableTrackId: true,
    ...overrides,
  };
}

function track(id: string, position: number): CachedPlaylistTrack {
  return {
    id,
    isrc: null,
    linkedFromIds: [],
    metadata: { title: id, artists: [], album: null, durationMs: null, playlistPosition: position },
  };
}

let container: HTMLDivElement;
let root: Root;
let editor: ThemeSongPlaylistEditor | null = null;

function Harness({ rows }: { rows: readonly MediaThemeSongRow[] }) {
  editor = useThemeSongPlaylistEditor(rows, OPTIONS);
  return null;
}
const OPTIONS = { mediaId: 1 };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  _clearToolsPreferencesForTesting();
  mocks.insert.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  _clearToolsPreferencesForTesting();
});

const rows = [
  makeRow({ spotifyTrackIds: ['op'] }),
  makeRow({ type: 'Ending', spotifyTrackIds: ['ed'] }),
  makeRow({ type: 'Insert', spotifyTrackIds: ['ins'] }),
];

describe('useThemeSongPlaylistEditor', () => {
  it('adds a show’s missing songs right after its last song on the playlist', async () => {
    mocks.cache = { playlistId: 'pl', fetchedAt: 1, revision: 1, tracks: [track('op', 8)], trackTotal: 10 };
    act(() => root.render(<Harness rows={rows} />));
    await act(async () => editor!.addRows(rows));
    expect(mocks.insert).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'ed' }), expect.objectContaining({ id: 'ins' })],
      { afterPosition: 8 },
    );
  });

  it('appends when none of the show is on the playlist', async () => {
    mocks.cache = { playlistId: 'pl', fetchedAt: 1, revision: 2, tracks: [track('x', 1)], trackTotal: 1 };
    act(() => root.render(<Harness rows={rows} />));
    await act(async () => editor!.addRows([rows[1]!]));
    expect(mocks.insert).toHaveBeenCalledWith([expect.objectContaining({ id: 'ed' })], {
      afterPosition: undefined,
    });
  });

  it('follows the removal preference, which defaults off', () => {
    expect(loadToolsPreferences().weeklyCalendarAllowPlaylistRemoval).toBe(false);
    act(() => root.render(<Harness rows={rows} />));
    expect(editor?.allowRemove).toBe(false);
    act(() => {
      saveToolsPreferences({ weeklyCalendarAllowPlaylistRemoval: true });
    });
    expect(editor?.allowRemove).toBe(true);
  });
});
