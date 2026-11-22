import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSongPreviewPlayer } from '../ThemeSongPreviewPlayer';

describe('ThemeSongPreviewPlayer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('changes volume without reloading the playing source', async () => {
    await act(async () => {
      root.render(
        <ThemeSongPreviewPlayer
          urls={{ annSongId: 1, videoUrl: 'https://example.com/a.webm', audioUrl: null }}
          label="Song preview"
        />,
      );
    });
    const video = container.querySelector<HTMLVideoElement>('video[aria-label="Song preview"]')!;
    const loads = vi.mocked(HTMLMediaElement.prototype.load).mock.contexts.filter((el) => el === video);
    expect(loads).toHaveLength(1);

    const slider = container.querySelector<HTMLInputElement>('input[aria-label="Volume"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(slider, '0.25');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(video.volume).toBe(0.25);
    expect(
      vi.mocked(HTMLMediaElement.prototype.load).mock.contexts.filter((el) => el === video),
    ).toHaveLength(1);
  });
});
