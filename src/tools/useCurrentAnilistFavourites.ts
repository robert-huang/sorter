import { useEffect, useState } from 'react';
import {
  productionReads,
  type FavouriteEntityIds,
} from '../lib/importers/anilist/readQueries';
import {
  readLastAnilistUsername,
  subscribeLastAnilistUsername,
} from '../lib/importers/anilist/lastUsername';

function emptyFavouriteEntityIds(): FavouriteEntityIds {
  return {
    mediaIds: new Set<number>(),
    characterIds: new Set<number>(),
    staffIds: new Set<number>(),
    studioIds: new Set<number>(),
  };
}

/**
 * Completed SQLite favourite snapshots for the last successfully imported
 * AniList account. Username notifications also refresh same-account imports.
 */
export function useCurrentAnilistFavourites(): FavouriteEntityIds {
  const [accountRevision, setAccountRevision] = useState(0);
  const [favourites, setFavourites] = useState<FavouriteEntityIds>(
    emptyFavouriteEntityIds,
  );

  useEffect(
    () =>
      subscribeLastAnilistUsername(() => {
        setAccountRevision((revision) => revision + 1);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const username = readLastAnilistUsername();
    if (!username) {
      setFavourites(emptyFavouriteEntityIds());
      return;
    }

    void productionReads
      .getFavouriteEntityIdsForUsername(username)
      .then((nextFavourites) => {
        if (!cancelled) {
          setFavourites(nextFavourites);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFavourites(emptyFavouriteEntityIds());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accountRevision]);

  return favourites;
}
