import { describe, expect, it } from 'vitest';
import { parseMalThemes } from '../themeSongs/malThemeParser';

const MAL_LIVE = process.env.MAL_LIVE === '1';
const clientId = process.env.VITE_MAL_CLIENT_ID?.trim();

/**
 * Validates the upstream MAL API contract (Node fetch — no CORS).
 * Run: `MAL_LIVE=1 npm test -- malOfficialApi.live`
 */
describe.skipIf(!MAL_LIVE || !clientId)('MAL official API live', () => {
  it('returns opening/ending theme strings for Horimiya (MAL 42897)', async () => {
    const url =
      'https://api.myanimelist.net/v2/anime/42897?fields=opening_themes,ending_themes';
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-MAL-CLIENT-ID': clientId!,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      opening_themes?: Array<{ text?: string }>;
      ending_themes?: Array<{ text?: string }>;
    };

    const openings = (body.opening_themes ?? []).map((t) => t.text).filter(Boolean);
    const endings = (body.ending_themes ?? []).map((t) => t.text).filter(Boolean);
    expect(openings.length).toBeGreaterThan(0);
    expect(endings.length).toBeGreaterThan(0);

    const parsed = parseMalThemes(openings as string[], endings as string[]);
    expect(parsed.some((row) => row.title.includes('Iro Kousui'))).toBe(true);
    expect(parsed.some((row) => row.title.includes('Yakusoku'))).toBe(true);
  });

  it('does not expose CORS headers on direct browser-origin requests', async () => {
    const url =
      'https://api.myanimelist.net/v2/anime/42897?fields=opening_themes,ending_themes';
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-MAL-CLIENT-ID': clientId!,
        Origin: 'http://localhost:5173',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
