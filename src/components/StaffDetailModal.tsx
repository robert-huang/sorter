import { useCallback, useEffect, useMemo, useState } from 'react';
import { isGraphTimestampStale } from '../lib/importers/anilist/graphConstants';
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
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../lib/importers/anilist/anilistLinks';
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

/** One-line freshness summary for the filmography cache, matching the
 *  media modal's cast/staff cache lines. */
function formatFilmographyLine(fetchedAt: number | null): string {
  if (fetchedAt === null) {
    return 'Filmography: not cached';
  }
  const stale = isGraphTimestampStale(fetchedAt);
  const date = new Date(fetchedAt).toLocaleDateString();
  return `Filmography: ${date} (${stale ? 'stale (>90d)' : 'fresh'})`;
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
function CreditRoleLine({ credit }: { credit: StaffFilmographyCredit }) {
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
            const characterLink = bindAnilistMiddleClick(
              anilistUrlForCharacter(character.id),
            );
            return (
              <span key={character.id}>
                {index > 0 ? ', ' : ''}
                <span
                  className={mergeAnilistLinkClass(
                    'anilist-detail-character-name',
                    characterLink.className,
                  )}
                  onMouseDown={characterLink.onMouseDown}
                  onAuxClick={characterLink.onAuxClick}
                >
                  {character.name}
                </span>
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
  // Bumped on every successful refresh so the load effect re-reads the
  // cached rows without re-triggering the first-open auto-expansion.
  const [loadTick, setLoadTick] = useState(0);
  // Latest cached AniList user id (null when no list cached) — gates the
  // "only items on my list" toggle ("if it's cached").
  const [listUserId, setListUserId] = useState<number | null>(null);
  // Media ids from this filmography that are on the cached user's list.
  const [myListIds, setMyListIds] = useState<Set<number>>(() => new Set());
  const [onlyMyList, setOnlyMyList] = useState(false);

  // Initial load + reload-on-refresh. Reads cached filmography rows,
  // kicks off a one-time expansion when the staff has never been
  // fetched, then resolves "on my list" membership for the toggle.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let d = await productionReads.getStaffFilmography(staffId);
        const user = await productionReads.getLatestAnilistUser();
        if (cancelled) return;
        setDetail(d);
        setListUserId(user?.id ?? null);
        setLoading(false);

        if (loadTick === 0 && d.fetchedAt === null) {
          setExpanding(true);
          setProgress(null);
          try {
            await runAnilistStaffFilmographyExpansion(staffId, (e) => {
              if (!cancelled) setProgress(e);
            });
            if (cancelled) return;
            d = await productionReads.getStaffFilmography(staffId);
            if (cancelled) return;
            setDetail(d);
          } catch (err) {
            if (cancelled) return;
            // Soft-fail: the (possibly empty) cached rows already
            // rendered; surface the error inline so the user can retry.
            setError(err instanceof Error ? err.message : 'Refresh failed.');
          } finally {
            if (!cancelled) {
              setExpanding(false);
              setProgress(null);
            }
          }
        }

        if (user && d.credits.length > 0) {
          const ids = d.credits.map((c) => c.media.id);
          const set = await productionReads.getMediaIdsInUserList(user.id, ids);
          if (!cancelled) setMyListIds(set);
        } else if (!cancelled) {
          setMyListIds(new Set());
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load staff.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [staffId, loadTick]);

  const onRefresh = useCallback(async () => {
    if (expanding) return;
    setExpanding(true);
    setError(null);
    setProgress(null);
    try {
      await runAnilistStaffFilmographyExpansion(staffId, (e) => setProgress(e));
      setLoadTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed.');
    } finally {
      setExpanding(false);
      setProgress(null);
    }
  }, [staffId, expanding]);

  const credits = detail?.credits ?? [];
  const visibleCredits = useMemo(() => {
    if (!onlyMyList) return credits;
    return credits.filter((c) => myListIds.has(c.media.id));
  }, [credits, onlyMyList, myListIds]);

  const name = pickName(detail, staffId, fallbackName);
  const staff = detail?.staff ?? null;
  const staffNameLink = bindAnilistMiddleClick(anilistUrlForStaffId(staffId));
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
          <h3
            className={staffNameLink.className}
            style={{ margin: 0, flex: 1, minWidth: 0 }}
            onMouseDown={staffNameLink.onMouseDown}
            onAuxClick={staffNameLink.onAuxClick}
          >
            {name}
          </h3>
          <button
            type="button"
            className={`btn small${
              isFilmographyStale && !expanding ? ' anilist-detail-refresh-stale' : ''
            }`}
            onClick={() => void onRefresh()}
            disabled={expanding}
            title={
              isFilmographyStale
                ? "This person's cached filmography is over 90 days old \u2014 click to re-fetch from AniList"
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
            ×
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
              <img
                className="anilist-detail-cover"
                src={staff.image}
                alt=""
                loading="lazy"
              />
            )}

            <div className="anilist-detail-meta">
              <div className="anilist-detail-meta-row">
                {staff?.name_native && <span>{staff.name_native}</span>}
                {staff?.language_v2 && <span>{staff.language_v2}</span>}
                {staff?.favourites !== null && staff?.favourites !== undefined && (
                  <span>★ {staff.favourites.toLocaleString()}</span>
                )}
                <a
                  href={anilistUrlForStaffId(staffId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  AniList ↗
                </a>
              </div>

              <div
                className="anilist-detail-meta-row"
                style={{ fontSize: 11, color: 'var(--text-muted)' }}
              >
                <span title="Filmography cache">
                  {formatFilmographyLine(detail.fetchedAt)}
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
                      const mediaLink = bindAnilistMiddleClick(
                        anilistUrlForMediaEntry(credit.media.type, credit.media.id),
                      );
                      return (
                        <li key={credit.media.id}>
                          <button
                            type="button"
                            className={mergeAnilistLinkClass(
                              'anilist-detail-cast-item anilist-detail-row-link',
                              mediaLink.className,
                            )}
                            onClick={() => onOpenMedia(credit.media.id, title)}
                            onMouseDown={mediaLink.onMouseDown}
                            onAuxClick={mediaLink.onAuxClick}
                            title={`Open ${title}`}
                          >
                            {credit.media.cover_image && (
                              <img
                                className="anilist-detail-cast-image"
                                src={credit.media.cover_image}
                                alt=""
                                loading="lazy"
                              />
                            )}
                            <span className="anilist-detail-cast-text">
                              <strong>{title}</strong>
                              <CreditRoleLine credit={credit} />
                              {metaLine && (
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                  {metaLine}
                                </span>
                              )}
                            </span>
                          </button>
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
