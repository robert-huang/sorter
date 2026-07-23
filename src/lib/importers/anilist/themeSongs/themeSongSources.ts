/** Per-source fetch health stored on the theme-songs payload. */
export type ThemeSongSourceHealth = {
  ok: boolean;
  /** HTTP status or short label when `ok` is false. */
  detail?: string;
};

export type ThemeSongSourcesHealth = {
  jikan: ThemeSongSourceHealth;
  aniplaylist: ThemeSongSourceHealth;
};

export function okSource(): ThemeSongSourceHealth {
  return { ok: true };
}

export function failedSource(detail: string): ThemeSongSourceHealth {
  return { ok: false, detail };
}

export function deriveLegacyAniplaylistAvailable(sources: ThemeSongSourcesHealth): boolean {
  return sources.aniplaylist.ok;
}

export function themeSongsSourceNotes(sources: ThemeSongSourcesHealth | undefined): string[] {
  if (!sources) {
    return [];
  }
  const notes: string[] = [];
  if (!sources.jikan.ok) {
    const detail = sources.jikan.detail ? ` (${sources.jikan.detail})` : '';
    notes.push(`MAL theme data unavailable${detail}.`);
  }
  if (!sources.aniplaylist.ok) {
    const detail = sources.aniplaylist.detail ? ` (${sources.aniplaylist.detail})` : '';
    notes.push(`AniPlaylist unavailable${detail} — Spotify links not enriched.`);
  }
  return notes;
}

export function allThemeSongSourcesFailed(sources: ThemeSongSourcesHealth | undefined): boolean {
  if (!sources) {
    return false;
  }
  return !sources.jikan.ok && !sources.aniplaylist.ok;
}
