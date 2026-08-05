import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Item } from '../../lib/types';
import { saveAnilistDisplayPreferences } from '../../lib/importers/anilist/displayPreferences';
import { EditItemModal } from '../EditItemModal';

const customItem: Item = {
  id: 'AAAAAAAAAAAAAQ',
  label: 'My squid show',
  source: { kind: 'anilist', externalId: 1 },
  anilistLabelMode: 'custom',
  anilistLabelIncludesFormat: true,
  anilistLabelSource: {
    kind: 'media',
    titleFields: {
      id: 1,
      title_romaji: 'Shinryaku! Ika Musume',
      title_english: 'Squid Girl',
      title_native: '侵略!',
    },
    format: 'TV',
  },
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  saveAnilistDisplayPreferences({ mediaTitleMode: 'english' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

describe('EditItemModal AniList custom labels', () => {
  it('offers to restore the current automatic title and label behavior', () => {
    const onSave = vi.fn();
    act(() => {
      root.render(
        <EditItemModal
          item={customItem}
          onCancel={vi.fn()}
          onSave={onSave}
        />,
      );
    });

    expect(container.textContent).toContain(
      'Custom label — AniList language settings will not replace it.',
    );

    act(() => buttonByText('Use AniList title').click());

    const labelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Item name"]',
    );
    expect(labelInput?.value).toBe('Squid Girl (TV)');

    act(() => buttonByText('Save').click());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Squid Girl (TV)',
        useAutomaticAnilistLabel: true,
      }),
    );
  });

  it('shows automatic status before a rename and custom controls as the user types', () => {
    const automaticItem: Item = {
      ...customItem,
      label: 'Squid Girl (TV)',
      anilistLabelMode: undefined,
    };
    act(() => {
      root.render(
        <EditItemModal
          item={automaticItem}
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain(
      'Automatic label — follows AniList language settings.',
    );
    expect(container.textContent).toContain('Using AniList title');

    const labelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Item name"]',
    );
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(labelInput, 'My renamed show');
      labelInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain(
      'Custom label — AniList language settings will not replace it.',
    );
    expect(buttonByText('Use AniList title')).toBeDefined();
  });

  it('recognizes custom labels saved before explicit label-mode tracking', () => {
    const legacyCustomItem: Item = {
      ...customItem,
      anilistLabelMode: undefined,
    };
    act(() => {
      root.render(
        <EditItemModal
          item={legacyCustomItem}
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain(
      'Custom label — AniList language settings will not replace it.',
    );
    expect(buttonByText('Use AniList title')).toBeDefined();
  });
});
