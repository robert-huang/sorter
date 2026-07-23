export type ThemeSongType = 'Opening' | 'Ending' | 'Insert';

export const THEME_SONG_TYPE_ORDER: readonly ThemeSongType[] = [
  'Opening',
  'Ending',
  'Insert',
];

export type MediaThemeSongRow = {
  type: ThemeSongType;
  sortOrder: number;

  malRaw?: string;
  malTitle?: string;
  malArtist?: string;
  malEpisodes?: string;

  songKey?: string;
  aniTitles?: string[];
  aniArtists?: string[];
  aniplaylistUrl?: string;

  displayTitle: string;
  displayArtist: string | null;
  spotifyUrl: string | null;
  spotifyTrackIds: string[];
  spotifyIsrc: string | null;
  hasResolvableTrackId: boolean;
};

import type { ThemeSongSourcesHealth } from './themeSongSources';

export type MediaThemeSongsPayload = {
  version: 1;
  /** Legacy flag — kept in sync with `sources.aniplaylist.ok` when present. */
  aniplaylistAvailable: boolean;
  sources?: ThemeSongSourcesHealth;
  rows: MediaThemeSongRow[];
};

export type MediaThemeSongsExpansion = {
  mediaId: number;
  malId: number | null;
  fetchedAt: number;
  payload: MediaThemeSongsPayload;
};
