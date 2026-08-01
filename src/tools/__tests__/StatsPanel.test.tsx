import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsSubrowNameCell } from '../panels/StatsPanel';
import type { StatsEntry } from '../panels/statsLogic';

const entry = {
  mediaId: 1,
  title: 'Cowboy Bebop',
  titleSource: {
    id: 1,
    title_romaji: 'Cowboy Bebop',
    title_english: 'Cowboy Bebop',
    title_native: 'カウボーイビバップ',
  },
  coverImage: null,
  mediaType: 'ANIME',
  format: null,
  mediaStatus: null,
  listStatus: 'COMPLETED',
  score: 10,
  repeat: 0,
  notes: null,
  progress: 26,
  progressVolumes: null,
  episodes: 26,
  chapters: null,
  volumes: null,
  duration: 24,
  meanScore: 86,
  startDate: { year: 1998, month: 4, day: 3 },
  genres: [],
  tags: [],
  studios: [],
  staffCredits: [],
  vaCredits: [],
} satisfies StatsEntry;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

describe('StatsSubrowNameCell', () => {
  it('keeps character links separate from the media-row link target', () => {
    act(() => {
      root.render(
        <StatsSubrowNameCell
          entry={entry}
          link={{
            characters: [
              {
                characterId: 2,
                characterName: 'Spike Spiegel',
                characterRole: 'MAIN',
              },
            ],
          }}
          onOpenMedia={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('a a')).toBeNull();
    expect(
      container.querySelector<HTMLAnchorElement>(
        '.tool-stats-subrow-show-link-target',
      )?.getAttribute('href'),
    ).toBe('https://anilist.co/anime/1');
    expect(
      container.querySelector<HTMLAnchorElement>(
        '.tool-character-name-link',
      )?.getAttribute('href'),
    ).toBe('https://anilist.co/character/2');
  });
});
