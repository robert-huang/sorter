import { parseLinesOnePerLine } from '../parseToolLines';

export type SeasonalShow = {
  id: number;
  title: string;
  season: string | null;
  seasonYear: number | null;
  score: number | null;
  notes: string | null;
};

export type SeasonSpec = {
  label: string;
  season: string | null;
  year: number;
};

export type SeasonalScoresForm = {
  username: string;
  seasonText: string;
  skipEmpty: boolean;
  airingNotesOnly: boolean;
};

export type SeasonColumn = {
  label: string;
  average: number | null;
  shows: Array<{ id: number; title: string; score: number | null }>;
};

export type SeasonalScoresResult =
  | { kind: 'empty'; message: string }
  | { kind: 'columns'; columns: SeasonColumn[] };

const SEASON_NAMES = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;

export function parseSeasonLine(line: string): { season: string | null; year: number } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const yearToken = parts[parts.length - 1];
  const year = Number.parseInt(yearToken, 10);
  if (!Number.isFinite(year)) {
    return null;
  }
  if (parts.length === 1) {
    return { season: null, year };
  }
  let season = parts.slice(0, -1).join(' ').toUpperCase();
  if (season === 'AUTUMN') {
    season = 'FALL';
  }
  return { season, year };
}

export function parseSeasonSpecs(
  text: string,
  shows: SeasonalShow[],
): SeasonSpec[] {
  const lines = parseLinesOnePerLine(text);

  if (lines.length === 0) {
    return [];
  }

  const years = shows
    .map((s) => s.seasonYear)
    .filter((y): y is number => y !== null && y > 0);
  const minYear = years.length > 0 ? Math.min(...years) : new Date().getFullYear();
  const maxYear = years.length > 0 ? Math.max(...years) : minYear;

  const specs: SeasonSpec[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower === 'all') {
      for (let year = minYear; year <= maxYear; year += 1) {
        specs.push({ label: String(year), season: null, year });
      }
      continue;
    }
    if (lower === 'allseasons') {
      for (let year = minYear; year <= maxYear; year += 1) {
        for (const season of SEASON_NAMES) {
          const label = `${season[0]}${season.slice(1).toLowerCase()} ${year}`;
          specs.push({ label, season, year });
        }
      }
      continue;
    }

    const parsed = parseSeasonLine(line);
    if (!parsed) {
      continue;
    }
    const label =
      parsed.season === null
        ? String(parsed.year)
        : `${parsed.season[0]}${parsed.season.slice(1).toLowerCase()} ${parsed.year}`;
    specs.push({ label, season: parsed.season, year: parsed.year });
  }

  return specs;
}

export function bucketShowsForSeason(
  shows: SeasonalShow[],
  spec: SeasonSpec,
  airingNotesOnly: boolean,
): SeasonalShow[] {
  return shows
    .filter((show) => {
      if (show.seasonYear !== spec.year) {
        return false;
      }
      if (spec.season && show.season !== spec.season) {
        return false;
      }
      if (airingNotesOnly && !(show.notes ?? '').includes('#airing')) {
        return false;
      }
      return true;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function averageScore(shows: SeasonalShow[]): number | null {
  const scored = shows.map((s) => s.score).filter((s): s is number => s !== null && s > 0);
  if (scored.length === 0) {
    return null;
  }
  const sum = scored.reduce((acc, n) => acc + n, 0);
  return Math.round((sum / scored.length) * 1000) / 1000;
}

export function buildSeasonalColumns(
  shows: SeasonalShow[],
  form: SeasonalScoresForm,
): SeasonalScoresResult {
  const specs = parseSeasonSpecs(form.seasonText, shows);
  if (specs.length === 0) {
    return { kind: 'empty', message: 'Enter at least one season or year to compare.' };
  }

  const columns: SeasonColumn[] = [];
  for (const spec of specs) {
    const bucket = bucketShowsForSeason(shows, spec, form.airingNotesOnly);
    if (form.skipEmpty && bucket.length === 0) {
      continue;
    }
    columns.push({
      label: spec.label,
      average: averageScore(bucket),
      shows: bucket.map((show) => ({
        id: show.id,
        title: show.title,
        score: show.score,
      })),
    });
  }

  if (columns.length === 0) {
    return { kind: 'empty', message: 'No scored shows matched those seasons.' };
  }

  return { kind: 'columns', columns };
}
