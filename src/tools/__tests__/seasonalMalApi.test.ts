import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMalSeasonalShows,
  malListEntryToSeasonalShow,
  parseMalUsername,
  type MalListEntry,
} from '../panels/seasonalMalApi';

const fetchMalOfficialJson = vi.fn();

vi.mock('../../lib/importers/anilist/themeSongs/malOfficialApi', () => ({
  fetchMalOfficialJson: (path: string) => fetchMalOfficialJson(path),
  isMalOfficialApiConfigured: () => true,
}));

function entry(id: number, status: string, score: number, extra: Partial<MalListEntry['node']> = {}): MalListEntry {
  return {
    node: {
      id,
      title: `MAL ${id}`,
      main_picture: { medium: `https://cdn.test/${id}.jpg`, large: `https://cdn.test/${id}l.jpg` },
      start_season: { year: 2002, season: 'spring' },
      start_date: '2002-04-04',
      end_date: '2002-09',
      media_type: 'tv',
      source: 'light_novel',
      genres: [
        { id: 2, name: 'Adventure' },
        { id: 79, name: 'Video Game' },
      ],
      ...extra,
    },
    list_status: { status, score },
  };
}

describe('parseMalUsername', () => {
  it('only accepts the mal: prefix', () => {
    expect(parseMalUsername('mal:alex')).toBe('alex');
    expect(parseMalUsername(' MAL:Alex ')).toBe('Alex');
    expect(parseMalUsername('alex')).toBeNull();
    expect(parseMalUsername('mal:')).toBeNull();
  });
});

describe('malListEntryToSeasonalShow', () => {
  it('maps a MAL entry onto a MAL-only seasonal show', () => {
    expect(malListEntryToSeasonalShow(entry(48, 'completed', 7))).toEqual({
      id: -48,
      malId: 48,
      origin: 'mal',
      title: 'MAL 48',
      coverImage: 'https://cdn.test/48l.jpg',
      season: 'SPRING',
      seasonYear: 2002,
      startDate: { year: 2002, month: 4, day: 4 },
      endDate: { year: 2002, month: 9, day: null },
      score: 70,
      repeat: null,
      notes: null,
      listStatus: 'COMPLETED',
      source: 'LIGHT_NOVEL',
      format: 'TV',
      genres: ['Adventure'],
    });
  });

  it('maps statuses, treats 0 as unrated, and skips dropped entries', () => {
    expect(malListEntryToSeasonalShow(entry(1, 'watching', 0))).toMatchObject({
      listStatus: 'CURRENT',
      score: null,
    });
    expect(malListEntryToSeasonalShow(entry(1, 'on_hold', 5))!.listStatus).toBe('PAUSED');
    expect(malListEntryToSeasonalShow(entry(1, 'plan_to_watch', 0))!.listStatus).toBe('PLANNING');
    expect(malListEntryToSeasonalShow(entry(1, 'dropped', 3))).toBeNull();
  });
});

describe('fetchMalSeasonalShows', () => {
  beforeEach(() => fetchMalOfficialJson.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('follows absolute paging.next links as /v2 paths', async () => {
    fetchMalOfficialJson
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: [entry(1, 'completed', 8)],
          paging: { next: 'https://api.myanimelist.net/v2/users/pagey/animelist?offset=1&limit=1' },
        },
      })
      .mockResolvedValueOnce({ status: 200, data: { data: [entry(2, 'dropped', 2)], paging: {} } });
    const shows = await fetchMalSeasonalShows('pagey');
    expect(shows.map((show) => show.id)).toEqual([-1]);
    expect(fetchMalOfficialJson.mock.calls[0][0]).toMatch(/^\/v2\/users\/pagey\/animelist\?fields=/);
    expect(fetchMalOfficialJson.mock.calls[1][0]).toBe('/v2/users/pagey/animelist?offset=1&limit=1');
  });

  it('explains a missing or private list', async () => {
    fetchMalOfficialJson.mockResolvedValueOnce({ status: 404, data: null });
    await expect(fetchMalSeasonalShows('ghost')).rejects.toThrow('MAL user "ghost" not found.');
    fetchMalOfficialJson.mockResolvedValueOnce({ status: 403, data: null });
    await expect(fetchMalSeasonalShows('shy')).rejects.toThrow('MAL list for "shy" is private.');
  });
});
