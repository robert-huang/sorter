import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolTabs, type ToolTab } from '../ToolTabs';

// React 18 requires this flag for act() outside of a test renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const TABS: ReadonlyArray<ToolTab<'a' | 'b'>> = [
  { id: 'a', label: 'Alpha', title: 'Alpha description' },
  { id: 'b', label: 'Beta', title: 'Beta description' },
];

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`button ${label} not found`);
  return btn;
}

describe('ToolTabs help strip', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hides the help strip until a tab is hovered', () => {
    act(() => {
      root.render(<ToolTabs tabs={TABS} activeTab="a" onTabChange={() => {}} />);
    });
    expect(container.querySelector('.tool-tab-help')).toBeNull();
  });

  it('shows the hovered tab description, then hides on mouse-out', () => {
    act(() => {
      root.render(<ToolTabs tabs={TABS} activeTab="a" onTabChange={() => {}} />);
    });

    const beta = findButton(container, 'Beta');
    // React synthesizes onMouseEnter from a native mouseover with no relatedTarget.
    act(() => {
      beta.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(container.querySelector('.tool-tab-help')?.textContent).toBe(
      'Beta description',
    );

    act(() => {
      beta.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
      );
    });
    expect(container.querySelector('.tool-tab-help')).toBeNull();
  });
});
