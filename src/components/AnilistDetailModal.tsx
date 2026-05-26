import { useCallback, useEffect, useState } from 'react';
import {
  type MediaDetail,
  productionReads,
} from '../lib/importers/anilist/readQueries';
import { runAnilistMediaLazyExpansion } from '../lib/importers/anilist/runners';

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
  onClose: () => void;
}

function pickTitle(d: MediaDetail | null, fallback: string): string {
  if (!d) return fallback;
  const m = d.media;
  return m.title_english ?? m.title_romaji ?? m.title_native ?? fallback;
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
  onClose,
}: Props) {
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bump on every successful expansion so the load effect re-runs and
  // re-reads cached rows. Distinct from `loading` because the initial
  // load and a Refresh-triggered re-load are conceptually different
  // (Refresh should not flash the whole spinner over the visible
  // panel; just spin the inline Refresh button).
  const [loadTick, setLoadTick] = useState(0);

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
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
        // First-open lazy expansion: if no cast cached, fetch now.
        // Skipped on Refresh-triggered reloads (loadTick > 0) — the
        // refresh handler kicks off its own expansion and bumps the
        // tick after it completes, so we'd otherwise expand twice.
        if (loadTick === 0 && d && d.characters.length === 0) {
          setExpanding(true);
          try {
            await runAnilistMediaLazyExpansion(mediaId);
            if (cancelled) return;
            const d2 = await productionReads.getMediaDetail(mediaId);
            if (cancelled) return;
            setDetail(d2);
          } catch (err) {
            if (cancelled) return;
            // Soft-fail: the cached metadata already rendered; the
            // expansion error just means the cast section stays in
            // its "loading…" -> "no cast yet" state. Log + display
            // the error inline so the user can retry.
            setError(err instanceof Error ? err.message : 'Refresh failed.');
          } finally {
            if (!cancelled) setExpanding(false);
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
  }, [mediaId, loadTick]);

  const onRefresh = useCallback(async () => {
    if (expanding) return;
    setExpanding(true);
    setError(null);
    try {
      await runAnilistMediaLazyExpansion(mediaId);
      setLoadTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed.');
    } finally {
      setExpanding(false);
    }
  }, [mediaId, expanding]);

  const title = pickTitle(detail, fallbackTitle);
  const m = detail?.media;

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
            className="btn small"
            onClick={() => void onRefresh()}
            disabled={expanding}
            title="Re-fetch cast & staff for this entry (does not auto-push)"
          >
            {expanding ? 'Refreshing…' : '↻ Refresh'}
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
                className="anilist-detail-cover"
                src={m.cover_image}
                alt=""
                loading="lazy"
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
                <h4>Cast {expanding ? '(refreshing…)' : ''}</h4>
                {detail.characters.length === 0 && !expanding && (
                  <p
                    style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}
                  >
                    No cast cached yet. Click ↻ Refresh to pull from AniList.
                  </p>
                )}
                {detail.characters.length > 0 && (
                  <ul className="anilist-detail-cast-list">
                    {detail.characters.map(
                      ({ character, role, voiceActors }) => (
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
                            <strong>{character.name_full ?? character.name_native ?? `Character #${character.id}`}</strong>
                            {role && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                {role}
                              </span>
                            )}
                            {voiceActors.length > 0 && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                                VA:{' '}
                                {voiceActors
                                  .map((va) => va.name_full ?? va.name_native ?? `#${va.id}`)
                                  .join(', ')}
                              </span>
                            )}
                          </div>
                        </li>
                      ),
                    )}
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
