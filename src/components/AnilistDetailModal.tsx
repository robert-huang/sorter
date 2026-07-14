import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formatGraphCacheDate,
  graphStaleRefreshTooltip,
  hasKnownGraphCacheDate,
  isGraphTimestampStale,
  oldestStaleGraphTimestamp,
} from '../lib/importers/anilist/graphConstants';
import type { MediaCastExpansionStatus } from '../lib/importers/anilist/readQueries';
import {
  type MediaDetail,
  productionReads,
} from '../lib/importers/anilist/readQueries';
import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';
import { filterProductionStaffRows } from '../lib/importers/anilist/staffRoleFilter';
import { runAnilistMediaLazyExpansion, runAnilistMediaRelationsRefresh } from '../lib/importers/anilist/runners';
import type { ToolsMediaRelationsResponse } from '../lib/importers/anilist/toolsMediaRelationsApi';
import { formatMediaSourceForDisplay } from '../lib/importers/anilist/mediaSourceLabel';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { pickCharacterName, pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import {
  anilistUrlForCharacter,
  anilistUrlForMediaEntry,
  anilistUrlForStaffId,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../lib/importers/anilist/anilistLinks';
import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';
import { formatAnilistProgress } from './anilistProgressLabel';
import { RemoveGlyph } from './RemoveGlyph';

const PRODUCTION_ROLE_MODE_KEY = 'anilist-detail-production-roles';

type ProductionRoleMode = 'key' | 'all';

function loadProductionRoleMode(): ProductionRoleMode {
  try {
    const v = localStorage.getItem(PRODUCTION_ROLE_MODE_KEY);
    return v === 'all' ? 'all' : 'key';
  } catch {
    return 'key';
  }
}

function formatExpansionLine(
  label: string,
  fetchedAt: number | null,
  complete: boolean,
): string {
  if (fetchedAt === null) {
    return `${label}: not cached`;
  }
  const stale = isGraphTimestampStale(fetchedAt);
  const date = formatGraphCacheDate(fetchedAt);
  const flags = [
    complete ? 'complete' : 'incomplete',
    stale ? 'stale (>90d)' : 'fresh',
  ].join(', ');
  return `${label}: ${date} (${flags})`;
}

/**
 * Empty-state copy for the Cast section. A successful expansion writes a
 * `media_cast_expansion` marker with `characters_complete = 1` even when
 * AniList genuinely lists no cast (e.g. music videos, sparse entries) —
 * so an empty `characters` array can mean either "never polled" or
 * "polled, nothing there". `charactersComplete` disambiguates: when it's
 * set we've fetched the full character list and it really is empty, so
 * telling the user to Refresh would be misleading.
 */
function castEmptyMessage(status: MediaCastExpansionStatus | null): string {
  if (status?.charactersComplete) {
    return 'No cast listed for this entry on AniList.';
  }
  return 'No cast cached yet. Click ↻ Refresh to pull from AniList.';
}

/**
 * Empty-state copy for the Production section. Mirrors
 * {@link castEmptyMessage}, plus a distinct branch for when credits ARE
 * cached but the "Key roles" filter hid them all — Refresh wouldn't
 * help there; switching to "All credits" would.
 */
function productionEmptyMessage(
  status: MediaCastExpansionStatus | null,
  roleMode: ProductionRoleMode,
  hasHiddenCredits: boolean,
): string {
  if (hasHiddenCredits) {
    return 'No key-role credits for this entry. Switch to All credits to see everything.';
  }
  if (status?.staffComplete) {
    return 'No production credits listed for this entry on AniList.';
  }
  const suffix = roleMode === 'key' ? ' (key roles)' : '';
  return `No production credits cached${suffix}. Click ↻ Refresh.`;
}

/**
 * Detail modal for a single AniList media id. Opens from LIST or
 * RESULT when the user clicks an item whose `source.kind === 'anilist'`.
 *
 * Lazy-expansion contract (Phase D plan §4):
 *   - On first open, if the cached `media_character` table has no
 *     rows for this media, run `expandAnilistMediaDetail` once to
 *     fetch characters / staff / VAs. Subsequent opens read cached
 *     rows directly.
 *   - User can also explicitly trigger a refresh via the Refresh
 *     button (Phase 5): re-runs the same expansion, bumps the
 *     pending-changes counter via the runner's onDirtyIncrement hook,
 *     and re-renders.
 *
 * Layout:
 *   - Header: title + close button.
 *   - Body left: cover image (180px wide).
 *   - Body right: metadata + studios + tags + cast (with VAs) + staff.
 *
 * Description is NOT rendered — the importer doesn't fetch it per
 * plan §A note. Add later if needed.
 */

interface Props {
  /** AniList media id to load. */
  mediaId: number;
  /** Fallback display title used while detail is loading and as the
   *  modal header. Comes from the clicked Item's `label` so the user
   *  always sees their slot's view of the title first. */
  fallbackTitle: string;
  /** When true, force a live AniList refresh on open (Tools show-title clicks). */
  initialForceRefresh?: boolean;
  onClose: () => void;
  /**
   * Open the staff detail panel for a cast VA / production-staff member.
   * Optional so existing call sites + tests that don't wire cross-panel
   * navigation render the names as plain text (see {@link PersonLink}).
   */
  onOpenStaff?: (staffId: number, fallbackName: string) => void;
  /** Fired after ↻ refresh writes fresh relations for this media id. */
  onMediaRelationsRefreshed?: (
    mediaId: number,
    response: ToolsMediaRelationsResponse,
  ) => void;
}

/**
 * Render a person's name as a button that opens their staff panel
 * (left-click) and their AniList page (middle-click). When no opener is
 * wired it renders as static text — still middle-clickable when an
 * `anilistUrl` is supplied. Used for cast VAs + production staff.
 */
function PersonLink({
  name,
  onOpen,
  anilistUrl,
}: {
  name: string;
  onOpen?: () => void;
  anilistUrl?: string;
}) {
  const anilistLink = bindAnilistMiddleClick(anilistUrl ?? null);

  if (!onOpen) {
    if (!anilistUrl) {
      return <>{name}</>;
    }
    return (
      <span
        className={mergeAnilistLinkClass(
          'anilist-detail-person-static',
          anilistLink.className,
        )}
        onMouseDown={anilistLink.onMouseDown}
        onAuxClick={anilistLink.onAuxClick}
      >
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={mergeAnilistLinkClass('anilist-detail-person-link', anilistLink.className)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onMouseDown={anilistLink.onMouseDown}
      onAuxClick={anilistLink.onAuxClick}
      title={`View ${name}'s filmography`}
    >
      {name}
    </button>
  );
}

/**
 * Resolve the modal header title using the user's media-title display
 * preference, with the caller-supplied label (the clicked Item's
 * `label`) as the final fallback. Sharing `pickMediaTitle` with the
 * chip pipeline keeps the modal header in sync with the chip label so
 * there's no flicker / mismatch when the detail row loads.
 */
function pickTitle(d: MediaDetail | null, fallback: string): string {
  if (!d) return fallback;
  return pickMediaTitle(d.media, undefined, fallback);
}

/** Render a fuzzy date as YYYY-MM-DD with `?` placeholders for the
 *  fields AniList doesn't know. Returns null when even the year is
 *  unknown — the caller hides the date row in that case. */
function fmtFuzzyDate(
  y: number | null,
  m: number | null,
  d: number | null,
): string | null {
  if (y === null) return null;
  const pad = (v: number | null) => (v === null ? '??' : String(v).padStart(2, '0'));
  if (m === null) return String(y);
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function AnilistDetailModal({
  mediaId,
  fallbackTitle,
  initialForceRefresh = false,
  onClose,
  onOpenStaff,
  onMediaRelationsRefreshed,
}: Props) {
  // Re-render the modal when the display preferences change so the
  // title / character / VA / staff names relabel live while it's open.
  useAnilistDisplayPreferences();
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest progress event from the in-flight lazy expansion. Drives
  // the "Cast (refreshing…)" subtitle so a slow character-page fetch
  // doesn't look like a dead spinner. Null when not expanding.
  const [progress, setProgress] = useState<AnilistProgressEvent | null>(null);
  // Bump on every successful expansion so the load effect re-runs and
  // re-reads cached rows. Distinct from `loading` because the initial
  // load and a Refresh-triggered re-load are conceptually different
  // (Refresh should not flash the whole spinner over the visible
  // panel; just spin the inline Refresh button).
  const [loadTick, setLoadTick] = useState(0);
  const [expansionStatus, setExpansionStatus] =
    useState<MediaCastExpansionStatus | null>(null);
  const [relationsFetchedAt, setRelationsFetchedAt] = useState<number | null>(null);
  const [productionRoleMode, setProductionRoleMode] =
    useState<ProductionRoleMode>(loadProductionRoleMode);

  const visibleProductionStaff = useMemo(() => {
    if (!detail) {
      return [];
    }
    return filterProductionStaffRows(
      detail.productionStaff,
      productionRoleMode,
      detail.media.type,
    );
  }, [detail, productionRoleMode]);

  const onProductionRoleModeChange = useCallback((mode: ProductionRoleMode) => {
    setProductionRoleMode(mode);
    try {
      localStorage.setItem(PRODUCTION_ROLE_MODE_KEY, mode);
    } catch {
      /* private mode */
    }
  }, []);

  // Initial load + reload-on-expansion. Reads the cached rows once
  // (so the metadata sidebar paints fast) then, if no characters are
  // cached yet, kicks off the expansion in the background. The
  // second load re-reads after the expansion lands.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const d = await productionReads.getMediaDetail(mediaId);
        const status = await productionReads.getMediaCastExpansionStatus(mediaId);
        const relationsAt =
          await productionReads.getMediaRelationsExpansionFetchedAt(mediaId);
        if (cancelled) return;
        setDetail(d);
        setExpansionStatus(status);
        setRelationsFetchedAt(relationsAt);
        setLoading(false);
        const needsExpansion =
          initialForceRefresh ||
          !status ||
          !status.charactersComplete ||
          !status.staffComplete ||
          !hasKnownGraphCacheDate(status.charactersFetchedAt) ||
          !hasKnownGraphCacheDate(status.staffFetchedAt);
        const shouldExpandOnOpen =
          loadTick === 0 && needsExpansion && (d !== null || initialForceRefresh);
        if (shouldExpandOnOpen) {
          setExpanding(true);
          setProgress(null);
          try {
            await runAnilistMediaLazyExpansion(
              mediaId,
              (e) => {
                if (!cancelled) setProgress(e);
              },
              initialForceRefresh ? { scope: 'all', force: true } : undefined,
            );
            if (cancelled) return;
            const d2 = await productionReads.getMediaDetail(mediaId);
            const status2 = await productionReads.getMediaCastExpansionStatus(mediaId);
            if (cancelled) return;
            setDetail(d2);
            setExpansionStatus(status2);
          } catch (err) {
            if (cancelled) return;
            // Soft-fail: the cached metadata already rendered; the
            // expansion error just means the cast section stays in
            // its "loading…" -> "no cast yet" state. Log + display
            // the error inline so the user can retry.
            setError(err instanceof Error ? err.message : 'Refresh failed.');
          } finally {
            if (!cancelled) {
              setExpanding(false);
              setProgress(null);
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load media.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaId, loadTick, initialForceRefresh]);

  const onRefresh = useCallback(async () => {
    if (expanding) return;
    setExpanding(true);
    setError(null);
    setProgress(null);
    try {
      await runAnilistMediaLazyExpansion(mediaId, (e) => setProgress(e), {
        scope: 'all',
        force: true,
      });
      const relationsResponse = await runAnilistMediaRelationsRefresh(
        mediaId,
        (e) => setProgress(e),
      );
      const status = await productionReads.getMediaCastExpansionStatus(mediaId);
      const relationsAt =
        await productionReads.getMediaRelationsExpansionFetchedAt(mediaId);
      setExpansionStatus(status);
      setRelationsFetchedAt(relationsAt);
      if (relationsResponse) {
        onMediaRelationsRefreshed?.(mediaId, relationsResponse);
      }
      setLoadTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed.');
    } finally {
      setExpanding(false);
      setProgress(null);
    }
  }, [mediaId, expanding, onMediaRelationsRefreshed]);

  // Highlight the Refresh button when either cached section is older than
  // the staleness threshold (>90d) — mirrors the staff modal's affordance
  // so the freshness text isn't the only stale signal.
  const isCastStale =
    !!expansionStatus &&
    ((expansionStatus.charactersFetchedAt !== null &&
      isGraphTimestampStale(expansionStatus.charactersFetchedAt)) ||
      (expansionStatus.staffFetchedAt !== null &&
        isGraphTimestampStale(expansionStatus.staffFetchedAt)));
  const castStaleFetchedAt = expansionStatus
    ? oldestStaleGraphTimestamp([
        expansionStatus.charactersFetchedAt,
        expansionStatus.staffFetchedAt,
      ])
    : null;

  const title = pickTitle(detail, fallbackTitle);
  const m = detail?.media;
  const coverAnilistLink = m
    ? bindAnilistMiddleClick(anilistUrlForMediaEntry(m.type, m.id))
    : bindAnilistMiddleClick(null);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal anilist-detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`AniList details for ${title}`}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <h3 style={{ margin: 0, flex: 1, minWidth: 0 }}>{title}</h3>
          <button
            type="button"
            className={`btn small${
              isCastStale && !expanding ? ' anilist-detail-refresh-stale' : ''
            }`}
            onClick={() => void onRefresh()}
            disabled={expanding}
            title={
              isCastStale && castStaleFetchedAt !== null
                ? graphStaleRefreshTooltip(
                    castStaleFetchedAt,
                    "This entry's cached cast/staff",
                  )
                : 'Re-fetch cast & staff for this entry (does not auto-push)'
            }
          >
            {expanding ? 'Refreshing…' : '↻ Refresh'}
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
        {!loading && !detail && !error && (
          <p style={{ color: 'var(--text-muted)' }}>
            Couldn't find this entry locally. Refresh your AniList list to
            re-cache its metadata.
          </p>
        )}
        {/* Render load errors at the top level so a failed initial fetch
            (detail === null) still surfaces the reason — otherwise the
            "couldn't find this entry" message hides the real cause. The
            duplicate inside the detail block below covers the
            cached-then-failed-refresh case. */}
        {!loading && !detail && error && (
          <p
            className="settings-source-db-error"
            role="alert"
            style={{ marginTop: 8 }}
          >
            {error}
          </p>
        )}

        {detail && m && (
          <div className="anilist-detail-body">
            {m.cover_image && (
              <img
                className={mergeAnilistLinkClass(
                  'anilist-detail-cover',
                  coverAnilistLink.className,
                )}
                src={m.cover_image}
                alt=""
                loading="lazy"
                title="Open on AniList (middle-click)"
                onMouseDown={coverAnilistLink.onMouseDown}
                onAuxClick={coverAnilistLink.onAuxClick}
              />
            )}

            <div className="anilist-detail-meta">
              <div className="anilist-detail-meta-row">
                {m.type && <span>{m.type}</span>}
                {m.format && <span>{m.format}</span>}
                {m.status && <span>{m.status}</span>}
                {m.season && (
                  <span>
                    {m.season}
                    {m.season_year !== null ? ` ${m.season_year}` : ''}
                  </span>
                )}
                {m.episodes !== null && <span>{m.episodes} ep</span>}
                {m.chapters !== null && <span>{m.chapters} ch</span>}
                {m.mean_score !== null && (
                  <span>⌀ {m.mean_score}/100</span>
                )}
                {m.favourites !== null && (
                  <span>★ {m.favourites.toLocaleString()}</span>
                )}
                {m.country_of_origin && <span>{m.country_of_origin}</span>}
                <span
                  title={
                    m.source_fetched_at != null
                      ? m.source != null
                        ? `AniList MediaSource: ${m.source}`
                        : 'AniList returned no adaptation source for this entry'
                      : 'Source not stored locally — refresh list or open ↻ Refresh'
                  }
                >
                  Source:{' '}
                  {formatMediaSourceForDisplay(m.source, {
                    sourceFetchedAt: m.source_fetched_at,
                  })}
                </span>
              </div>
              {(() => {
                const start = fmtFuzzyDate(m.start_year, m.start_month, m.start_day);
                const end = fmtFuzzyDate(m.end_year, m.end_month, m.end_day);
                if (!start && !end) return null;
                return (
                  <div className="anilist-detail-meta-row">
                    {start && <span>Start: {start}</span>}
                    {end && <span>End: {end}</span>}
                  </div>
                );
              })()}

              {m.genres_json && (
                <div className="anilist-detail-meta-row">
                  {(() => {
                    let genres: string[] = [];
                    try {
                      const parsed = JSON.parse(m.genres_json) as unknown;
                      if (Array.isArray(parsed)) {
                        genres = parsed.filter(
                          (g): g is string => typeof g === 'string',
                        );
                      }
                    } catch {
                      /* malformed JSON renders as no chips */
                    }
                    return genres.map((g) => (
                      <span
                        key={g}
                        className="anilist-detail-tag-item"
                        style={{ borderRadius: 4 }}
                      >
                        {g}
                      </span>
                    ));
                  })()}
                </div>
              )}

              {detail.studios.length > 0 && (
                <div className="anilist-detail-section">
                  <h4>Studios</h4>
                  <ul className="anilist-detail-tag-list">
                    {detail.studios.map((s) => (
                      <li
                        key={s.studio.id}
                        className="anilist-detail-tag-item"
                      >
                        {s.studio.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {expansionStatus && (
                <div
                  className="anilist-detail-meta-row"
                  style={{ fontSize: 11, color: 'var(--text-muted)' }}
                >
                  <span title="Cast cache">
                    {formatExpansionLine(
                      'Cast',
                      expansionStatus.charactersFetchedAt,
                      expansionStatus.charactersComplete,
                    )}
                  </span>
                  <span title="Staff credits cache">
                    {formatExpansionLine(
                      'Staff',
                      expansionStatus.staffFetchedAt,
                      expansionStatus.staffComplete,
                    )}
                  </span>
                  <span title="Franchise relations cache">
                    {relationsFetchedAt === null
                      ? 'Relations: not cached'
                      : `Relations: ${formatGraphCacheDate(relationsFetchedAt)}${
                          isGraphTimestampStale(relationsFetchedAt)
                            ? ' (stale >90d)'
                            : ' (fresh)'
                        }`}
                  </span>
                </div>
              )}

              {detail.tags.length > 0 && (
                <div className="anilist-detail-section">
                  <h4>Tags</h4>
                  <ul className="anilist-detail-tag-list">
                    {detail.tags.map((t) => (
                      <li key={t.name} className="anilist-detail-tag-item">
                        {t.name}
                        <span className="anilist-detail-tag-rank">
                          {' '}
                          {t.rank}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="anilist-detail-section">
                <h4>
                  Cast{' '}
                  {expanding && (
                    <span
                      style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 'normal' }}
                      aria-live="polite"
                    >
                      ({progress ? formatAnilistProgress(progress) : 'refreshing…'})
                    </span>
                  )}
                </h4>
                {detail.characters.length === 0 && !expanding && (
                  <p
                    style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}
                  >
                    {castEmptyMessage(expansionStatus)}
                  </p>
                )}
                {detail.characters.length > 0 && (
                  <ul className="anilist-detail-cast-list">
                    {detail.characters.map(
                      ({ character, role, voiceActors }) => {
                        const characterName = pickCharacterName(
                          character,
                          undefined,
                          'Character',
                        );
                        const characterLink = bindAnilistMiddleClick(
                          anilistUrlForCharacter(character.id),
                        );
                        return (
                        <li
                          key={character.id}
                          className="anilist-detail-cast-item"
                        >
                          {character.image && (
                            <img
                              className="anilist-detail-cast-image"
                              src={character.image}
                              alt=""
                              loading="lazy"
                            />
                          )}
                          <div className="anilist-detail-cast-text">
                            <strong
                              className={mergeAnilistLinkClass(
                                'anilist-detail-character-name',
                                characterLink.className,
                              )}
                              onMouseDown={characterLink.onMouseDown}
                              onAuxClick={characterLink.onAuxClick}
                            >
                              {characterName}
                            </strong>
                            {role && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                {role}
                              </span>
                            )}
                            {voiceActors.length > 0 && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                VA:{' '}
                                {voiceActors.map((va, i) => {
                                  const vaName = pickPersonName(va, undefined, 'Staff');
                                  return (
                                    <span key={va.id}>
                                      {i > 0 ? ', ' : ''}
                                      <PersonLink
                                        name={vaName}
                                        onOpen={
                                          onOpenStaff
                                            ? () => onOpenStaff(va.id, vaName)
                                            : undefined
                                        }
                                        anilistUrl={anilistUrlForStaffId(va.id)}
                                      />
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                          </div>
                        </li>
                        );
                      },
                    )}
                  </ul>
                )}
              </div>

              <div className="anilist-detail-section">
                <h4>
                  Production{' '}
                  <span style={{ fontSize: 11, fontWeight: 'normal' }}>
                    <label style={{ marginRight: 8 }}>
                      <input
                        type="radio"
                        name={`production-roles-${mediaId}`}
                        checked={productionRoleMode === 'key'}
                        onChange={() => onProductionRoleModeChange('key')}
                      />{' '}
                      Key roles
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`production-roles-${mediaId}`}
                        checked={productionRoleMode === 'all'}
                        onChange={() => onProductionRoleModeChange('all')}
                      />{' '}
                      All credits
                    </label>
                  </span>
                </h4>
                {visibleProductionStaff.length === 0 && !expanding && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
                    {productionEmptyMessage(
                      expansionStatus,
                      productionRoleMode,
                      detail.productionStaff.length > 0,
                    )}
                  </p>
                )}
                {visibleProductionStaff.length > 0 && (
                  <ul className="anilist-detail-cast-list">
                    {visibleProductionStaff.map(({ staff, role }) => (
                      <li key={`${staff.id}-${role}`} className="anilist-detail-cast-item">
                        {staff.image && (
                          <img
                            className="anilist-detail-cast-image"
                            src={staff.image}
                            alt=""
                            loading="lazy"
                          />
                        )}
                        <div className="anilist-detail-cast-text">
                          <strong>
                            <PersonLink
                              name={pickPersonName(staff, undefined, 'Staff')}
                              onOpen={
                                onOpenStaff
                                  ? () =>
                                      onOpenStaff(
                                        staff.id,
                                        pickPersonName(staff, undefined, 'Staff'),
                                      )
                                  : undefined
                              }
                              anilistUrl={anilistUrlForStaffId(staff.id)}
                            />
                          </strong>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                            {role}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {error && (
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
