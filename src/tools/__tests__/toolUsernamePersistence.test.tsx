import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANILIST_LAST_USERNAME_LS_KEY } from '../../lib/importers/anilist/lastUsername';
import { FranchiseScoresPanel } from '../panels/FranchiseScoresPanel';
import { SeasonalScoresPanel } from '../panels/SeasonalScoresPanel';
import type { ToolPanelProps } from '../toolTypes';

const props: ToolPanelProps = {
  onOpenMedia: vi.fn(),
  onOpenStaff: vi.fn(),
  dbSyncRevision: 0,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function usernameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[name="anilist-username"]');
  if (!input) {
    throw new Error('Expected an AniList username input');
  }
  return input;
}

describe('tool username persistence', () => {
  it('keeps the Franchise Scores username separate from the global last import', () => {
    localStorage.setItem(ANILIST_LAST_USERNAME_LS_KEY, 'GlobalUser');
    localStorage.setItem(
      'anime-tools-franchise-scores-form',
      JSON.stringify({ username: 'FranchiseUser' }),
    );

    act(() => {
      root.render(<FranchiseScoresPanel {...props} />);
    });

    expect(usernameInput().value).toBe('FranchiseUser');
    expect(
      JSON.parse(localStorage.getItem('anime-tools-franchise-scores-form') ?? '{}').username,
    ).toBe('FranchiseUser');
  });

  it('keeps the Seasonal Scores username separate from the global last import', () => {
    localStorage.setItem(ANILIST_LAST_USERNAME_LS_KEY, 'GlobalUser');
    localStorage.setItem(
      'anime-tools-seasonal-scores-form',
      JSON.stringify({ username: 'SeasonalUser' }),
    );

    act(() => {
      root.render(<SeasonalScoresPanel {...props} />);
    });

    expect(usernameInput().value).toBe('SeasonalUser');
    expect(
      JSON.parse(localStorage.getItem('anime-tools-seasonal-scores-form') ?? '{}').username,
    ).toBe('SeasonalUser');
  });
});
