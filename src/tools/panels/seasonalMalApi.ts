import {
  fetchMalOfficialJson,
  isMalOfficialApiConfigured,
} from '../../lib/importers/anilist/themeSongs/malOfficialApi';
import {
  TOOLS_SESSION_TTL_MS,
  sessionMemoDelete,
  withSessionTtlMemo,
} from '../../lib/importers/anilist/toolsSessionMemo';
import type { AnilistMediaSource } from '../../lib/importers/anilist/types';
import type { SeasonalFuzzyDate, SeasonalShow } from './seasonalScoresLogic';

const MAL_USERNAME_PREFIX = 'mal:';
const MAL_LIST_FIELDS =
  'list_status,start_season,start_date,end_date,media_type,source,genres,main_picture';

export type MalListEntry = {
  node: {
    id: number;
    title: string;
    main_picture?: { medium?: string; large?: string } | null;
    start_season?: { year: number; season: string } | null;
    start_date?: string | null;
    end_date?: string | null;
    media_type?: string | null;
    source?: string | null;
    genres?: { id: number; name: string }[] | null;
  };
  list_status?: { status?: string | null; score?: number | null } | null;
};

type MalListPage = { data?: MalListEntry[]; paging?: { next?: string } };

/** `mal:alex` → `alex`; null for AniList usernames (which can't contain `:`). */
export function parseMalUsername(username: string): string | null {
  const trimmed = username.trim();
  if (!trimmed.toLowerCase().startsWith(MAL_USERNAME_PREFIX)) return null;
  const name = trimmed.slice(MAL_USERNAME_PREFIX.length).trim();
  return name || null;
}

/** Seasonal Scores loads AniList lists without DROPPED, so MAL drops are skipped too. */
const MAL_STATUS_TO_ANILIST: Record<string, string> = {
  watching: 'CURRENT',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  plan_to_watch: 'PLANNING',
};

const MAL_FORMAT_TO_ANILIST: Record<string, string> = {
  tv: 'TV',
  movie: 'MOVIE',
  ova: 'OVA',
  ona: 'ONA',
  special: 'SPECIAL',
  tv_special: 'SPECIAL',
  music: 'MUSIC',
};

const MAL_SOURCE_TO_ANILIST: Record<string, AnilistMediaSource> = {
  original: 'ORIGINAL',
  manga: 'MANGA',
  '4_koma_manga': 'MANGA',
  web_manga: 'MANGA',
  digital_manga: 'MANGA',
  light_novel: 'LIGHT_NOVEL',
  novel: 'NOVEL',
  web_novel: 'WEB_NOVEL',
  visual_novel: 'VISUAL_NOVEL',
  game: 'VIDEO_GAME',
  card_game: 'GAME',
  book: 'NOVEL',
  picture_book: 'PICTURE_BOOK',
  mixed_media: 'MULTIMEDIA_PROJECT',
  other: 'OTHER',
  radio: 'OTHER',
  music: 'OTHER',
};

/** MAL genres that exist on AniList; MAL themes and demographics are dropped. */
const MAL_GENRE_TO_ANILIST: Record<string, string> = {
  Action: 'Action',
  Adventure: 'Adventure',
  Comedy: 'Comedy',
  Drama: 'Drama',
  Ecchi: 'Ecchi',
  Fantasy: 'Fantasy',
  Hentai: 'Hentai',
  Horror: 'Horror',
  'Mahou Shoujo': 'Mahou Shoujo',
  Mecha: 'Mecha',
  Music: 'Music',
  Mystery: 'Mystery',
  Psychological: 'Psychological',
  Romance: 'Romance',
  'Sci-Fi': 'Sci-Fi',
  'Slice of Life': 'Slice of Life',
  Sports: 'Sports',
  Supernatural: 'Supernatural',
  Suspense: 'Thriller',
};

/** MAL dates are `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. */
function parseMalDate(value: string | null | undefined): SeasonalFuzzyDate | null {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value ?? '');
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: match[2] ? Number(match[2]) : null,
    day: match[3] ? Number(match[3]) : null,
  };
}

/** One MAL list entry as a MAL-only show (`id = -malId`); null for skipped statuses. */
export function malListEntryToSeasonalShow(entry: MalListEntry): SeasonalShow | null {
  const listStatus = MAL_STATUS_TO_ANILIST[entry.list_status?.status ?? ''];
  if (!listStatus) return null;
  const { node } = entry;
  const malScore = entry.list_status?.score ?? 0;
  const genres = (node.genres ?? [])
    .map((genre) => MAL_GENRE_TO_ANILIST[genre.name])
    .filter((genre): genre is string => Boolean(genre));
  return {
    id: -node.id,
    malId: node.id,
    origin: 'mal',
    title: node.title,
    coverImage: node.main_picture?.large ?? node.main_picture?.medium ?? null,
    season: node.start_season?.season.toUpperCase() ?? null,
    seasonYear: node.start_season?.year ?? null,
    startDate: parseMalDate(node.start_date),
    endDate: parseMalDate(node.end_date),
    score: malScore > 0 ? malScore * 10 : null,
    repeat: null,
    notes: null,
    listStatus,
    source: MAL_SOURCE_TO_ANILIST[node.source ?? ''] ?? null,
    format: MAL_FORMAT_TO_ANILIST[node.media_type ?? ''] ?? null,
    genres: [...new Set(genres)],
  };
}

/** `paging.next` is an absolute api.myanimelist.net URL; the proxy fetch wants the `/v2/…` path. */
function malNextPath(next: string | undefined): string | null {
  if (!next) return null;
  try {
    const url = new URL(next);
    return url.pathname.startsWith('/v2/') ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

function malListErrorMessage(name: string, status: number | null): string {
  if (status === 404) return `MAL user "${name}" not found.`;
  if (status === 403) return `MAL list for "${name}" is private.`;
  return `Couldn't load MAL list for "${name}".`;
}

async function fetchMalListResolved(name: string, signal?: AbortSignal): Promise<SeasonalShow[]> {
  if (!isMalOfficialApiConfigured()) {
    throw new Error('MAL import needs the MAL proxy (VITE_MAL_PROXY_URL) or a MAL client id.');
  }
  const shows: SeasonalShow[] = [];
  let path: string | null =
    `/v2/users/${encodeURIComponent(name)}/animelist?fields=${MAL_LIST_FIELDS}&limit=1000&nsfw=true`;
  while (path) {
    signal?.throwIfAborted();
    const { data, status } = await fetchMalOfficialJson<MalListPage>(path);
    if (!data) throw new Error(malListErrorMessage(name, status));
    for (const entry of data.data ?? []) {
      const show = malListEntryToSeasonalShow(entry);
      if (show) shows.push(show);
    }
    path = malNextPath(data.paging?.next);
  }
  return shows;
}

function malMemoKey(name: string): string {
  return `seasonal:mal:${name.toLowerCase()}`;
}

export function bustMalSeasonalSessionMemo(name: string): void {
  sessionMemoDelete(malMemoKey(name));
}

/** A `mal:` user's list as MAL-only shows, memoized like AniList lists. */
export async function fetchMalSeasonalShows(
  name: string,
  signal?: AbortSignal,
  options?: { forceRefresh?: boolean },
): Promise<SeasonalShow[]> {
  signal?.throwIfAborted();
  return withSessionTtlMemo(
    malMemoKey(name),
    TOOLS_SESSION_TTL_MS,
    () => fetchMalListResolved(name, signal),
    { bust: options?.forceRefresh },
  );
}
