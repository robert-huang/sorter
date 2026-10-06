import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
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

export function ThemeSongPreviewPlayer({ urls, label }: Props) {
  const playerId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(() => getThemeSongPreviewVolume());
  const [usingAudioFallback, setUsingAudioFallback] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  const primarySrc = urls.videoUrl;
  const fallbackSrc = urls.audioUrl;

  const pauseSelf = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.pause();
    setPlaying(false);
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

  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    setUsingAudioFallback(false);
    setMediaError(false);
    setCurrentTime(0);
    setDuration(0);
    el.volume = volume;
    el.src = primarySrc;
    void el.load();
    void el.play().then(
      () => {
        pauseOtherPreviews(playerId);
        setPlaying(true);
      },
      () => {
        setPlaying(false);
      },
    );
  }, [playerId, primarySrc]);

  const onVideoClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      const el = videoRef.current;
      if (!el || mediaError) {
        return;
      }
      if (el.paused) {
        pauseOtherPreviews(playerId);
        void el.play().then(
          () => setPlaying(true),
          () => setPlaying(false),
        );
      } else {
        el.pause();
        setPlaying(false);
      }
    },
    [mediaError, playerId],
  );

  const onTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
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
  }, []);

  const onSeek = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    const next = Number(event.target.value);
    el.currentTime = next;
    setCurrentTime(next);
  }, []);

  const onVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const next = Number(event.target.value);
    setVolume(next);
    setThemeSongPreviewVolume(next);
    const el = videoRef.current;
    if (el) {
      el.volume = next;
    }
  }, []);

  const onMediaError = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    if (!usingAudioFallback && fallbackSrc && el.src !== fallbackSrc) {
      setUsingAudioFallback(true);
      el.src = fallbackSrc;
      void el.load();
      void el.play().then(
        () => {
          pauseOtherPreviews(playerId);
          setPlaying(true);
          setMediaError(false);
        },
        () => {
          setPlaying(false);
          setMediaError(true);
        },
      );
      return;
    }
    setMediaError(true);
    setPlaying(false);
  }, [fallbackSrc, playerId, usingAudioFallback]);

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
            preload="metadata"
            aria-label={label}
            onClick={onVideoClick}
            onTimeUpdate={onTimeUpdate}
            onLoadedMetadata={onLoadedMetadata}
            onEnded={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={onMediaError}
          />
          <div className="anilist-detail-theme-song-preview-controls">
            <input
              type="range"
              className="anilist-detail-theme-song-preview-seek"
              min={0}
              max={maxDuration}
              step={0.1}
              value={Math.min(currentTime, maxDuration)}
              onChange={onSeek}
              aria-label="Seek"
            />
            <label className="anilist-detail-theme-song-preview-volume-label">
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
            </label>
            <span className="anilist-detail-theme-song-preview-state" aria-hidden="true">
              {playing ? '▮▮' : '▶'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
