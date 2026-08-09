import { describe, expect, it } from 'vitest';
import {
  buildFranchiseActivitiesCsv,
  buildFranchiseActivitiesPlainText,
  classifyFranchiseActivity,
  filterFranchiseActivitiesByType,
  formatFranchiseActivityDate,
  formatFranchiseActivityText,
  groupFranchiseActivitiesByMedia,
  sortFranchiseActivitiesByDate,
  type FranchiseActivity,
} from '../panels/franchiseActivitiesLogic';

function activity(
  id: number,
  overrides: Partial<FranchiseActivity> = {},
): FranchiseActivity {
  return {
    id,
    status: 'watched episode',
    progress: String(id),
    createdAt: 1_700_000_000 + id,
    siteUrl: `https://anilist.co/activity/${id}`,
    replyCount: 0,
    media: {
      id: 100,
      type: 'ANIME',
      title: 'Fate/Zero',
      siteUrl: 'https://anilist.co/anime/100',
    },
    ...overrides,
  };
}

describe('franchise activity formatting', () => {
  it('formats progress and planning text for display', () => {
    expect(formatFranchiseActivityText(activity(12))).toBe(
      'Watched episode 12',
    );
    expect(
      formatFranchiseActivityText(
        activity(13, { status: 'plans to watch', progress: null }),
      ),
    ).toBe('Plan to watch');
  });

  it('classifies every activity filter bucket', () => {
    expect(classifyFranchiseActivity(activity(1))).toBe('PROGRESS');
    expect(
      classifyFranchiseActivity(activity(2, { status: 'completed' })),
    ).toBe('COMPLETED');
    expect(
      classifyFranchiseActivity(activity(3, { status: 'plans to read' })),
    ).toBe('PLANNING');
    expect(
      classifyFranchiseActivity(activity(4, { status: 'paused watching' })),
    ).toBe('PAUSED');
    expect(
      classifyFranchiseActivity(activity(5, { status: 'dropped' })),
    ).toBe('DROPPED');
  });

  it('filters activity types without changing their order', () => {
    const rows = [
      activity(1),
      activity(2, { status: 'completed' }),
      activity(3, { status: 'dropped' }),
    ];
    expect(
      filterFranchiseActivitiesByType(rows, ['PROGRESS', 'DROPPED']).map(
        (row) => row.id,
      ),
    ).toEqual([1, 3]);
  });

  it('formats dates in the requested timezone', () => {
    expect(formatFranchiseActivityDate(0, 'UTC')).toBe(
      'Thu, Jan 1, 1970',
    );
  });
});

describe('franchise activity ordering and grouping', () => {
  it('sorts timestamps ascending with an id tiebreak', () => {
    const rows = [
      activity(3, { createdAt: 30 }),
      activity(2, { createdAt: 10 }),
      activity(1, { createdAt: 10 }),
    ];
    expect(sortFranchiseActivitiesByDate(rows).map((row) => row.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it('uses chart media order and ascending dates within each group', () => {
    const rows = [
      activity(1, {
        createdAt: 30,
        media: {
          id: 100,
          type: 'ANIME',
          title: 'Anime',
          siteUrl: 'https://anilist.co/anime/100',
        },
      }),
      activity(2, {
        createdAt: 10,
        media: {
          id: 200,
          type: 'MANGA',
          title: 'Manga',
          siteUrl: 'https://anilist.co/manga/200',
        },
      }),
      activity(3, {
        createdAt: 20,
        media: {
          id: 100,
          type: 'ANIME',
          title: 'Anime',
          siteUrl: 'https://anilist.co/anime/100',
        },
      }),
    ];
    const groups = groupFranchiseActivitiesByMedia(rows, [200, 100]);
    expect(groups.map((group) => group.mediaId)).toEqual([200, 100]);
    expect(groups[1]?.activities.map((row) => row.id)).toEqual([3, 1]);
  });
});

describe('franchise activity exports', () => {
  it('copies date mode exactly as media, activity, and date rows', () => {
    const row = activity(1, { createdAt: 0 });
    expect(
      buildFranchiseActivitiesPlainText([row], 'date', [100], 'UTC'),
    ).toBe('Fate/Zero — Watched episode 1 — Thu, Jan 1, 1970');
  });

  it('copies media mode with a group header and indented rows', () => {
    const row = activity(1, { createdAt: 0 });
    expect(
      buildFranchiseActivitiesPlainText([row], 'media', [100], 'UTC'),
    ).toBe(
      ['Fate/Zero', '  Watched episode 1 — Thu, Jan 1, 1970'].join('\n'),
    );
  });

  it('exports the requested CSV columns and escapes values', () => {
    const row = activity(1, {
      createdAt: 0,
      media: {
        id: 100,
        type: 'ANIME',
        title: 'Fate, "Zero"',
        siteUrl: 'https://anilist.co/anime/100',
      },
    });
    expect(buildFranchiseActivitiesCsv([row], 'UTC')).toBe(
      [
        'mediaName,mediaUrl,date,activity,activityUrl',
        '"Fate, ""Zero""",https://anilist.co/anime/100,"Thu, Jan 1, 1970",Watched episode 1,https://anilist.co/activity/1',
      ].join('\r\n'),
    );
  });
});
