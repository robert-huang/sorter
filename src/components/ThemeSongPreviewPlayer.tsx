import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { AnisongdbPreviewUrls } from '../lib/importers/anilist/themeSongs/anisongdbMatch';
import {
  getThemeSongPreviewVolume,
  setThemeSongPreviewVolume,
} from '../lib/spotify/themeSongPreviewPreferences';

const PAUSE_OTHERS_EVENT = 'theme-song-preview-pause-others';

function pauseOtherPreviews(keepId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(PAUSE_OTHERS_EVENT, { detail: { keepId } }),
  );
}

type Props = {
  urls: AnisongdbPreviewUrls;
  label: string;
};

type HoverPreviewState = {
  visible: boolean;
  leftPercent: number;
};

export function ThemeSongPreviewPlayer({ urls, label }: Props) {
  const playerId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const seekInputRef = useRef<HTMLInputElement | null>(null);
  const seekHoverRef = useRef(false);
  const seekDragRef = useRef(false);
  const scrubSnapshotRef = useRef({ time: 0, playing: false });
  const [hasVideoPicture, setHasVideoPicture] = useState(true);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState>({
    visible: false,
    leftPercent: 0,
  });
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(() => getThemeSongPreviewVolume());
  const [usingAudioFallback, setUsingAudioFallback] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [activeSrc, setActiveSrc] = useState(urls.videoUrl);

  const primarySrc = urls.videoUrl;
  const fallbackSrc = urls.audioUrl;

  const pauseSelf = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.pause();
  }, []);

  useEffect(() => {
    const onPauseOthers = (event: Event) => {
      const keepId = (event as CustomEvent<{ keepId: string }>).detail?.keepId;
      if (keepId !== playerId) {
        pauseSelf();
      }
    };
    window.addEventListener(PAUSE_OTHERS_EVENT, onPauseOthers);
    return () => window.removeEventListener(PAUSE_OTHERS_EVENT, onPauseOthers);
  }, [pauseSelf, playerId]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.volume = volume;
    }
  }, [volume]);

  const syncHoverPreviewSrc = useCallback((src: string) => {
    const preview = hoverPreviewVideoRef.current;
    if (!preview) {
      return;
    }
    preview.muted = true;
    preview.preload = 'auto';
    if (preview.src !== src) {
      preview.src = src;
      preview.load();
    }
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    setUsingAudioFallback(false);
    setMediaError(false);
    setHasVideoPicture(true);
    setActiveSrc(primarySrc);
    setCurrentTime(0);
    setDuration(0);
    setHoverPreview({ visible: false, leftPercent: 0 });
    el.volume = volume;
    el.src = primarySrc;
    syncHoverPreviewSrc(primarySrc);
    void el.load();
    void el.play().then(
      () => {
        pauseOtherPreviews(playerId);
      },
      () => {},
    );
  }, [playerId, primarySrc, syncHoverPreviewSrc, volume]);

  const onVideoClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      const el = videoRef.current;
      if (!el || mediaError) {
        return;
      }
      if (el.paused) {
        pauseOtherPreviews(playerId);
        void el.play().catch(() => {});
      } else {
        el.pause();
      }
    },
    [mediaError, playerId],
  );

  const onTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el || seekDragRef.current) {
      return;
    }
    setCurrentTime(el.currentTime);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    setDuration(el.duration);
    setHasVideoPicture(el.videoWidth > 0);
  }, []);

  const pointerSeekRatio = useCallback(
    (clientX: number): number | null => {
      const input = seekInputRef.current;
      if (!input || duration <= 0) {
        return null;
      }
      const rect = input.getBoundingClientRect();
      if (rect.width <= 0) {
        return null;
      }
      return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    },
    [duration],
  );

  const seekMainVideoTo = useCallback((time: number) => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.currentTime = time;
    setCurrentTime(time);
  }, []);

  const showHoverPreviewAt = useCallback(
    (clientX: number) => {
      if (!hasVideoPicture) {
        return;
      }
      const ratio = pointerSeekRatio(clientX);
      if (ratio === null) {
        return;
      }
      const time = ratio * duration;
      const preview = hoverPreviewVideoRef.current;
      if (preview) {
        preview.currentTime = time;
      }
      setHoverPreview({ visible: true, leftPercent: ratio * 100 });
    },
    [duration, hasVideoPicture, pointerSeekRatio],
  );

  const hideHoverPreview = useCallback(() => {
    setHoverPreview({ visible: false, leftPercent: 0 });
  }, []);

  const onSeek = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = Number(event.target.value);
      seekMainVideoTo(next);
    },
    [seekMainVideoTo],
  );

  const finishSeekDrag = useCallback(
    (clientX: number) => {
      if (!seekDragRef.current) {
        return;
      }
      seekDragRef.current = false;
      const ratio = pointerSeekRatio(clientX);
      if (ratio !== null) {
        seekMainVideoTo(ratio * duration);
      }
      const el = videoRef.current;
      if (el && scrubSnapshotRef.current.playing) {
        void el.play().catch(() => {});
      }
    },
    [duration, pointerSeekRatio, seekMainVideoTo],
  );

  const onSeekPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      seekDragRef.current = true;
      hideHoverPreview();
      const el = videoRef.current;
      scrubSnapshotRef.current = {
        time: el?.currentTime ?? 0,
        playing: el ? !el.paused : false,
      };
      el?.pause();
      const ratio = pointerSeekRatio(event.clientX);
      if (ratio !== null) {
        seekMainVideoTo(ratio * duration);
      }

      const onWindowPointerUp = (up: globalThis.PointerEvent) => {
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerUp);
        finishSeekDrag(up.clientX);
      };
      window.addEventListener('pointerup', onWindowPointerUp);
      window.addEventListener('pointercancel', onWindowPointerUp);
    },
    [duration, finishSeekDrag, hideHoverPreview, pointerSeekRatio, seekMainVideoTo],
  );

  const onSeekPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (seekDragRef.current) {
        const ratio = pointerSeekRatio(event.clientX);
        if (ratio !== null) {
          seekMainVideoTo(ratio * duration);
        }
        return;
      }
      if (seekHoverRef.current) {
        showHoverPreviewAt(event.clientX);
      }
    },
    [duration, pointerSeekRatio, seekMainVideoTo, showHoverPreviewAt],
  );

  const onSeekPointerEnter = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!hasVideoPicture) {
        return;
      }
      seekHoverRef.current = true;
      showHoverPreviewAt(event.clientX);
    },
    [hasVideoPicture, showHoverPreviewAt],
  );

  const onSeekPointerLeave = useCallback(() => {
    seekHoverRef.current = false;
    if (!seekDragRef.current) {
      hideHoverPreview();
    }
  }, [hideHoverPreview]);

  const onSeekPointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      finishSeekDrag(event.clientX);
    },
    [finishSeekDrag],
  );

  const onVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    setVolume(next);
    setThemeSongPreviewVolume(next);
    const el = videoRef.current;
    if (el) {
      el.volume = next;
    }
  }, []);

  const onFullscreen = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    const el = videoRef.current;
    if (!el) {
      return;
    }
    const request =
      el.requestFullscreen ??
      (el as HTMLVideoElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;
    if (request) {
      void request.call(el).catch(() => {
        // Fullscreen denied or unsupported — ignore.
      });
    }
  }, []);

  const onMediaError = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    if (!usingAudioFallback && fallbackSrc && el.src !== fallbackSrc) {
      setUsingAudioFallback(true);
      setActiveSrc(fallbackSrc);
      el.src = fallbackSrc;
      syncHoverPreviewSrc(fallbackSrc);
      void el.load();
      void el.play().then(
        () => {
          pauseOtherPreviews(playerId);
          setMediaError(false);
        },
        () => {
          setMediaError(true);
        },
      );
      return;
    }
    setMediaError(true);
  }, [fallbackSrc, playerId, syncHoverPreviewSrc, usingAudioFallback]);

  const maxDuration = duration > 0 ? duration : 0;

  return (
    <div
      className="anilist-detail-theme-song-preview"
      onClick={(event) => event.stopPropagation()}
    >
      {mediaError ? (
        <p className="anilist-detail-theme-song-preview-error">Preview unavailable</p>
      ) : (
        <>
          <video
            ref={videoRef}
            className="anilist-detail-theme-song-preview-video"
            playsInline
            preload="auto"
            aria-label={label}
            onClick={onVideoClick}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => {}}
            onError={onMediaError}
          />
          <div className="anilist-detail-theme-song-preview-controls">
            <div
              className="anilist-detail-theme-song-preview-seek-wrap"
              onPointerDown={onSeekPointerDown}
              onPointerMove={onSeekPointerMove}
              onPointerEnter={onSeekPointerEnter}
              onPointerLeave={onSeekPointerLeave}
              onPointerUp={onSeekPointerUp}
              onPointerCancel={onSeekPointerUp}
              title={
                hasVideoPicture
                  ? 'Hover for frame preview; drag to seek'
                  : 'Seek (audio only — no video frames)'
              }
            >
              <div
                className={[
                  'anilist-detail-theme-song-preview-hover',
                  hoverPreview.visible && hasVideoPicture ? 'is-visible' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${hoverPreview.leftPercent}%` }}
                aria-hidden="true"
              >
                <video
                  ref={hoverPreviewVideoRef}
                  className="anilist-detail-theme-song-preview-hover-video"
                  src={activeSrc}
                  muted
                  playsInline
                  preload="auto"
                  tabIndex={-1}
                />
              </div>
              <input
                ref={seekInputRef}
                type="range"
                className="anilist-detail-theme-song-preview-seek"
                min={0}
                max={maxDuration}
                step={0.1}
                value={Math.min(currentTime, maxDuration)}
                onChange={onSeek}
                aria-label="Seek"
              />
            </div>
            <input
              type="range"
              className="anilist-detail-theme-song-preview-volume"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={onVolumeChange}
              aria-label="Volume"
            />
            <button
              type="button"
              className="anilist-detail-theme-song-preview-fullscreen"
              onClick={onFullscreen}
              title="Fullscreen"
              aria-label="Fullscreen"
            >
              ⛶
            </button>
          </div>
        </>
      )}
    </div>
  );
}
