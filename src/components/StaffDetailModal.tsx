import { useCallback, useEffect, useMemo, useState } from 'react';
import { RemoveGlyph } from './RemoveGlyph';
import {
  formatGraphCacheDate,
  graphStaleRefreshTooltip,
  isGraphTimestampStale,
} from '../lib/importers/anilist/graphConstants';
import {
  type StaffFilmography,
  type StaffFilmographyCredit,
  productionReads,
} from '../lib/importers/anilist/readQueries';
import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';
import { runAnilistStaffFilmographyExpansion } from '../lib/importers/anilist/runners';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import {
  anilistUrlForCharacter,
  anilistUrlForMediaEntry,
  anilistUrlForStaffId,
} from '../lib/importers/anilist/anilistLinks';
import {
  readLastAnilistUsername,
  subscribeLastAnilistUsername,
} from '../lib/importers/anilist/lastUsername';
import { AnilistMiddleClickLink } from '../lib/importers/anilist/AnilistMiddleClickLink';
import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';
import { formatAnilistProgress } from './anilistProgressLabel';

/**
 * Detail modal for a single AniList staff/person id — the counterpart
 * to {@link AnilistDetailModal} (which is media-only). Shows the staff
 * member's filmography: every cached media they have a production
 * credit on (`media_staff`) or voiced a character in
 * (`character_voice_actor`), merged per media via
 * {@link productionReads.getStaffFilmography}.
 *
 * Lazy-expansion contract (mirrors the media modal):
 *   - On first open, if the staff has never been expanded
 *     (`fetchedAt === null`), run `runAnilistStaffFilmographyExpansion`
 *     once to pull `Staff.staffMedia` + `Staff.characterMedia`, then
 *     re-read the cached rows. Subsequent opens read cache directly.
 *   - The Refresh button always re-runs the expansion.
 *
 * Entry points: opened from a staff item's thumb / detail button (via
 * the app-level opener routing on `source.kind === 'anilist-staff'`)
 * AND from clicking a VA / production-staff name inside the media
 * modal. Each filmography row links back to the media modal via
 * `onOpenMedia`, so the two panels navigate to each other.
 */

interface Props {
  /** AniList staff id to load. */
  staffId: number;
  /** Fallback display name shown while loading + as the header. Comes
   *  from the clicked item's `label` / the media modal's resolved VA
   *  name so the user sees a stable title before the row loads. */
  fallbackName: string;
  onClose: () => void;
  /** Open the media detail modal for one of this staff's credits. */
  onOpenMedia: (mediaId: number, fallbackTitle: string) => void;
}

/** Resolve the header title using the person-name display preference,
 *  falling back to the caller-supplied label. */
function pickName(d: StaffFilmography | null, staffId: number, fallback: string): string {
  if (d?.staff) {
    return pickPersonName(d.staff, undefined, fallback);
  }
  return fallback || `Staff #${staffId}`;
}

/** One-line freshness summary matching the media modal's graph cache lines. */
function formatCacheLine(label: string, fetchedAt: number | null): string {
  if (fetchedAt === null) {
    return `${label}: not cached`;
  }
  const stale = isGraphTimestampStale(fetchedAt);
  const date = formatGraphCacheDate(fetchedAt);
  return `${label}: ${date} (${stale ? 'stale (>90d)' : 'fresh'})`;
}

/** Year + format suffix for a credit row, e.g. "2009 · TV". Omits
 *  pieces AniList doesn't know rather than rendering blanks. */
function creditMetaLine(credit: StaffFilmographyCredit): string {
  const parts: string[] = [];
  if (credit.media.start_year !== null) parts.push(String(credit.media.start_year));
  if (credit.media.format) parts.push(credit.media.format);
  return parts.join(' \u00B7 ');
}

/**
 * Role summary for a credit: production roles ("Director") plus any voiced
 * characters ("voiced X, Y"), joined on one compact line. Each voiced
 * character is middle-clickable to open its AniList page in a new tab.
 */
function CreditRoleLine({
  credit,
  favouriteCharacterIds,
}: {
  credit: StaffFilmographyCredit;
  favouriteCharacterIds: ReadonlySet<number>;
}) {
  const hasProduction = credit.productionRoles.length > 0;
  const hasVoiced = credit.voicedCharacters.length > 0;
  if (!hasProduction && !hasVoiced) {
    return null;
  }
  return (
    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
      {credit.productionRoles.join(' \u2022 ')}
      {hasProduction && hasVoiced ? ' \u2022 ' : ''}
      {hasVoiced && (
        <>
          voiced{' '}
          {credit.voicedCharacters.map((character, index) => {
            const isFavourite = favouriteCharacterIds.has(character.id);
            return (
              <span key={character.id}>
                {index > 0 ? ', ' : ''}
                <AnilistMiddleClickLink
                  url={anilistUrlForCharacter(character.id)}
                  className={`anilist-detail-character-name${
                    isFavourite
                      ? ' anilist-detail-character-name--favourite'
                      : ''
                  }`}
                >
                  {character.name}
                  {isFavourite ? (
                    <>
                      {' '}
                      <span
                        className="anilist-detail-character-favourite-star"
                        aria-label="Favourite character"
                      >
                        ★
                      </span>
                    </>
                  ) : null}
                </AnilistMiddleClickLink>
              </span>
            );
          })}
        </>
      )}
    </span>
  );
}

export function StaffDetailModal({
  staffId,
  fallbackName,
  onClose,
  onOpenMedia,
}: Props) {
  // Re-render when display preferences change so names relabel live.
  useAnilistDisplayPreferences();
  const [detail, setDetail] = useState<StaffFilmography | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnilistProgressEvent | null>(null);
  // Latest cached AniList user id (null when no list cached) — gates the
  // "only items on my list" toggle ("if it's cached").
  const [listUserId, setListUserId] = useState<number | null>(null);
  // Media ids from this filmography that are on the cached user's list.
  const [myListIds, setMyListIds] = useState<Set<number>>(() => new Set());
  const [onlyMyList, setOnlyMyList] = useState(false);
  const [favouriteMediaIds, setFavouriteMediaIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [favouriteCharacterIds, setFavouriteCharacterIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [favouriteStaffIds, setFavouriteStaffIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [favouriteAccountRevision, setFavouriteAccountRevision] = useState(0);

  useEffect(() => {
    return subscribeLastAnilistUsername(() => {
      setFavouriteAccountRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const username = readLastAnilistUsername();
    if (!username) {
      setFavouriteMediaIds(new Set());
      setFavouriteCharacterIds(new Set());
      setFavouriteStaffIds(new Set());
      return;
    }
    void productionReads
      .getFavouriteEntityIdsForUsername(username)
      .then(({ mediaIds, characterIds, staffIds }) => {
        if (!cancelled) {
          setFavouriteMediaIds(mediaIds);
          setFavouriteCharacterIds(characterIds);
          setFavouriteStaffIds(staffIds);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFavouriteMediaIds(new Set());
          setFavouriteCharacterIds(new Set());
          setFavouriteStaffIds(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [staffId, favouriteAccountRevision]);

  const refreshMyListIds = useCallback(
    async (userId: number | null, creditMediaIds: readonly number[]) => {
      if (userId && creditMediaIds.length > 0) {
        const onList = await productionReads.getMediaIdsInUserList(userId, creditMediaIds);
        setMyListIds(onList);
      } else {
        setMyListIds(new Set());
      }
    },
    [],
  );

  const applyFilmography = useCallback(
    async (options?: { autoExpandIfMissing?: boolean; isStale?: () => boolean }) => {
      if (options?.isStale?.()) {
        return;
      }
      let d = await productionReads.getStaffFilmography(staffId);
      if (options?.isStale?.()) {
        return;
      }
      const user = await productionReads.getLatestAnilistUser();
      if (options?.isStale?.()) {
        return;
      }
      setDetail(d);
      setListUserId(user?.id ?? null);

      if (options?.autoExpandIfMissing && d.fetchedAt === null) {
        setExpanding(true);
        setProgress(null);
        try {
          await runAnilistStaffFilmographyExpansion(staffId, (e) => {
            if (!options?.isStale?.()) {
              setProgress(e);
            }
          });
          if (options?.isStale?.()) {
            return;
          }
          d = await productionReads.getStaffFilmography(staffId);
          if (options?.isStale?.()) {
            return;
          }
          setDetail(d);
        } catch (err) {
          if (!options?.isStale?.()) {
            setError(err instanceof Error ? err.message : 'Refresh failed.');
          }
        } finally {
          if (!options?.isStale?.()) {
            setExpanding(false);
            setProgress(null);
          }
        }
      }

      if (options?.isStale?.()) {
        return;
      }
      await refreshMyListIds(user?.id ?? null, d.credits.map((c) => c.media.id));
    },
    [staffId, refreshMyListIds],
  );

  // Initial load: read cache, auto-expand once when never fetched, resolve list toggle.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void applyFilmography({
      autoExpandIfMissing: true,
      isStale: () => cancelled,
    })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load staff.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [staffId, applyFilmography]);

  const onRefresh = useCallback(async () => {
    if (expanding) {
      return;
    }
    setExpanding(true);
    setError(null);
    setProgress(null);
    const refreshGeneration = staffId;
    try {
      await runAnilistStaffFilmographyExpansion(staffId, (e) => setProgress(e));
      await applyFilmography({
        isStale: () => refreshGeneration !== staffId,
      });
    } catch (err) {
      if (refreshGeneration === staffId) {
        setError(err instanceof Error ? err.message : 'Refresh failed.');
      }
    } finally {
      if (refreshGeneration === staffId) {
        setExpanding(false);
        setProgress(null);
      }
    }
  }, [staffId, expanding, applyFilmography]);

  const credits = detail?.credits ?? [];
  const visibleCredits = useMemo(() => {
    if (!onlyMyList) return credits;
    return credits.filter((c) => myListIds.has(c.media.id));
  }, [credits, onlyMyList, myListIds]);

  const name = pickName(detail, staffId, fallbackName);
  const staff = detail?.staff ?? null;
  const isFavouriteStaff = favouriteStaffIds.has(staffId);
  const hasStaffMeta =
    !!staff?.name_native ||
    !!staff?.language_v2 ||
    (staff?.favourites !== null && staff?.favourites !== undefined);
  // Highlight the Refresh button when the cached filmography is older
  // than the staleness threshold (>90d) — the freshness line alone is
  // easy to miss, so the action affordance itself signals "update me".
  const isFilmographyStale =
    !!detail &&
    detail.fetchedAt !== null &&
    isGraphTimestampStale(detail.fetchedAt);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal anilist-detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`AniList staff details for ${name}`}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <h3 style={{ margin: 0, flex: 1, minWidth: 0 }}>
            <AnilistMiddleClickLink
              url={anilistUrlForStaffId(staffId)}
              className={`anilist-detail-heading-link${
                isFavouriteStaff ? ' anilist-detail-person-link--favourite' : ''
              }`}
              style={{ margin: 0 }}
            >
              {name}
              {isFavouriteStaff ? (
                <>
                  {' '}
                  <span
                    className="anilist-detail-person-favourite-star"
                    aria-label="Favourite staff"
                  >
                    ★
                  </span>
                </>
              ) : null}
            </AnilistMiddleClickLink>
          </h3>
          <a
            className="anilist-detail-external-link"
            href={anilistUrlForStaffId(staffId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            AniList ↗
          </a>
          <button
            type="button"
            className={`btn small${
              isFilmographyStale && !expanding ? ' anilist-detail-refresh-stale' : ''
            }`}
            onClick={() => void onRefresh()}
            disabled={expanding}
            title={
              isFilmographyStale && detail.fetchedAt !== null
                ? graphStaleRefreshTooltip(
                    detail.fetchedAt,
                    "This person's cached filmography",
                  )
                : "Re-fetch this person's filmography from AniList (does not auto-push)"
            }
          >
            {expanding ? 'Refreshing\u2026' : '\u21BB Refresh'}
          </button>
          <button
            type="button"
            className="x-button"
            onClick={onClose}
            aria-label="Close"
          >
            <RemoveGlyph size={12} />
          </button>
        </div>

        {loading && <p>Loading…</p>}
        {!loading && error && !detail && (
          <p className="settings-source-db-error" role="alert" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}

        {detail && (
          <div className="anilist-detail-body">
            {staff?.image && (
              <AnilistMiddleClickLink
                url={anilistUrlForStaffId(staffId)}
                className="anilist-detail-cover-link"
                title="Open on AniList (middle-click)"
              >
                <img
                  className="anilist-detail-cover"
                  src={staff.image}
                  alt=""
                  loading="lazy"
                />
              </AnilistMiddleClickLink>
            )}

            <div className="anilist-detail-meta">
              {hasStaffMeta && (
                <div className="anilist-detail-meta-row">
                  {staff?.name_native && <span>{staff.name_native}</span>}
                  {staff?.language_v2 && <span>{staff.language_v2}</span>}
                  {staff?.favourites !== null &&
                    staff?.favourites !== undefined && (
                      <span>★ {staff.favourites.toLocaleString()}</span>
                    )}
                </div>
              )}

              <div
                className="anilist-detail-meta-row"
                style={{ fontSize: 11, color: 'var(--text-muted)' }}
              >
                <span title="Staff info cache">
                  {formatCacheLine('Info', staff?.fetched_at ?? null)}
                </span>
                <span title="Filmography cache">
                  {formatCacheLine('Filmography', detail.fetchedAt)}
                </span>
              </div>

              <div className="anilist-detail-section">
                <h4>
                  Filmography{' '}
                  {expanding && (
                    <span
                      style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 'normal' }}
                      aria-live="polite"
                    >
                      ({progress ? formatAnilistProgress(progress) : 'refreshing\u2026'})
                    </span>
                  )}
                  {!expanding && credits.length > 0 && (
                    <span
                      style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 'normal' }}
                    >
                      {' '}
                      ({visibleCredits.length}
                      {onlyMyList ? ` of ${credits.length}` : ''})
                    </span>
                  )}
                </h4>

                {listUserId !== null && credits.length > 0 && (
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      marginBottom: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={onlyMyList}
                      onChange={(e) => setOnlyMyList(e.target.checked)}
                    />
                    Only items on my list
                  </label>
                )}

                {credits.length === 0 && !expanding && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                    {detail.fetchedAt !== null
                      ? 'No filmography listed for this person on AniList.'
                      : 'No filmography cached yet. Click \u21BB Refresh to pull from AniList.'}
                  </p>
                )}
                {credits.length > 0 && visibleCredits.length === 0 && onlyMyList && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                    None of this person's works are on your list.
                  </p>
                )}

                {visibleCredits.length > 0 && (
                  <ul className="anilist-detail-cast-list">
                    {visibleCredits.map((credit) => {
                      const title = pickMediaTitle(credit.media);
                      const metaLine = creditMetaLine(credit);
                      // Left-click opens the media modal; middle-click opens the
                      // media's AniList page (voiced-character names inside the
                      // row stop propagation to open their own pages instead).
                      return (
                        <li key={credit.media.id}>
                          <div className="anilist-detail-cast-item anilist-detail-row-link">
                            <AnilistMiddleClickLink
                              url={anilistUrlForMediaEntry(credit.media.type, credit.media.id)}
                              className="anilist-detail-row-link-target"
                              aria-label={`Open ${title}`}
                              title={`Open ${title}`}
                              onPrimaryClick={() => onOpenMedia(credit.media.id, title)}
                            >
                              {null}
                            </AnilistMiddleClickLink>
                            {credit.media.cover_image && (
                              <img
                                className="anilist-detail-cast-image"
                                src={credit.media.cover_image}
                                alt=""
                                loading="lazy"
                              />
                            )}
                            <span className="anilist-detail-cast-text">
                              <strong
                                className={`anilist-detail-media-title${
                                  favouriteMediaIds.has(credit.media.id)
                                    ? ' anilist-detail-media-title--favourite'
                                    : ''
                                }`}
                              >
                                {title}
                                {favouriteMediaIds.has(credit.media.id) ? (
                                  <>
                                    {' '}
                                    <span
                                      className="anilist-detail-media-favourite-star"
                                      aria-label="Favourite media"
                                    >
                                      ★
                                    </span>
                                  </>
                                ) : null}
                              </strong>
                              <CreditRoleLine
                                credit={credit}
                                favouriteCharacterIds={favouriteCharacterIds}
                              />
                              {metaLine && (
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                  {metaLine}
                                </span>
                              )}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {error && detail && (
                <p
                  className="settings-source-db-error"
                  role="alert"
                  style={{ marginTop: 8 }}
                >
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
