import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getFavouritesMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/importers/anilist/readQueries', () => ({
  productionReads: {
    getFavouriteEntityIdsForUsername: getFavouritesMock,
  },
}));

import { writeLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import { useCurrentAnilistFavourites } from '../useCurrentAnilistFavourites';

let container: HTMLDivElement;
let root: Root;

function FavouriteProbe() {
  const favourites = useCurrentAnilistFavourites();
  return (
    <output>
      {[
        favourites.mediaIds.size,
        favourites.characterIds.size,
        favourites.staffIds.size,
        favourites.studioIds.size,
      ].join(':')}
    </output>
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  localStorage.clear();
  getFavouritesMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCurrentAnilistFavourites', () => {
  it('reads cache-backed snapshots and refreshes after same-account writes', async () => {
    getFavouritesMock
      .mockResolvedValueOnce({
        mediaIds: new Set([1]),
        characterIds: new Set([2]),
        staffIds: new Set<number>(),
        studioIds: new Set<number>(),
      })
      .mockResolvedValueOnce({
        mediaIds: new Set([1]),
        characterIds: new Set([2]),
        staffIds: new Set([3]),
        studioIds: new Set([4]),
      });

    await act(async () => {
      root.render(<FavouriteProbe />);
    });
    expect(container.textContent).toBe('0:0:0:0');

    await act(async () => {
      writeLastAnilistUsername('CurrentUser');
      await Promise.resolve();
    });
    expect(getFavouritesMock).toHaveBeenLastCalledWith('CurrentUser');
    expect(container.textContent).toBe('1:1:0:0');

    await act(async () => {
      writeLastAnilistUsername('CurrentUser');
      await Promise.resolve();
    });
    expect(getFavouritesMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('1:1:1:1');
  });
});
