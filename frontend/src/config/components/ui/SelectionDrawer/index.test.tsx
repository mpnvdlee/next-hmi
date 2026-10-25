import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SelectionDrawer from '.';

describe('SelectionDrawer rail', () => {
  it('keeps a clicked category active until the user scrolls', () => {
    let spy: IntersectionObserverCallback = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          spy = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <SelectionDrawer
        action="Add action"
        searchPlaceholder="Search"
        searchAriaLabel="Search"
        categories={['Screens', 'Machine', 'Logic'].map((category) => ({
          category,
          items: [category.toLowerCase()],
        }))}
        itemKey={(i) => i}
        itemMatches={() => true}
        renderItem={(i) => <span>{i}</span>}
        onSelectItem={vi.fn()}
        emptyMessage={() => null}
        onClose={vi.fn()}
      />,
    );
    const rail = (name: string) => screen.getByRole('button', { name });
    // The section scroll-spy sees on top when a near-the-end one cannot get there.
    const spyOn = (name: string) =>
      act(() =>
        spy(
          [
            {
              isIntersecting: true,
              boundingClientRect: { top: 0 },
              target: document.querySelector(`[data-category="${name}"]`)!,
            } as unknown as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        ),
      );

    fireEvent.click(rail('Logic'));
    spyOn('Machine');
    expect(rail('Logic')).toHaveClass('cfg-selection-drawer__rail-item--active');

    fireEvent.wheel(document.querySelector('.cfg-selection-drawer__scroll')!);
    spyOn('Machine');
    expect(rail('Machine')).toHaveClass('cfg-selection-drawer__rail-item--active');

    // Typing a search moves the sections too, so it ends the hold as a scroll does.
    fireEvent.click(rail('Logic'));
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'm' },
    });
    spyOn('Machine');
    expect(rail('Machine')).toHaveClass('cfg-selection-drawer__rail-item--active');
    vi.unstubAllGlobals();
  });
});
