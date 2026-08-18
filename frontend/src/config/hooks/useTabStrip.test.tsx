import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combinedTabs, scrollTabsWithWheel, useTabStrip } from './useTabStrip';

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  callback: ResizeObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function setOverflowing(el: HTMLElement, overflowing: boolean) {
  Object.defineProperty(el, 'scrollWidth', { value: overflowing ? 500 : 100, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 100, configurable: true });
}

function Harness({
  openTabIds,
  previewTabId,
  getSnapshot,
  setActiveTab,
}: {
  openTabIds: string[];
  previewTabId: string | null;
  getSnapshot: () => {
    openTabIds: string[];
    previewTabId: string | null;
    activeTabId: string | null;
  };
  setActiveTab: (id: string) => void;
}) {
  const { scrollRef, overflows, dropdownOpen, setDropdownOpen } = useTabStrip({
    openTabIds,
    previewTabId,
    getSnapshot,
    setActiveTab,
  });
  return (
    <div>
      <div ref={scrollRef} data-testid="scroller" />
      <span data-testid="overflows">{String(overflows)}</span>
      <span data-testid="dropdown-open">{String(dropdownOpen)}</span>
      <button onClick={() => setDropdownOpen(true)}>open dropdown</button>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  ResizeObserverStub.instances = [];
  // jsdom doesn't implement scrollTo; the preview-tab reveal effect calls it.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('combinedTabs', () => {
  it('appends the preview tab when it is not already pinned', () => {
    expect(combinedTabs(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a preview tab that is already pinned', () => {
    expect(combinedTabs(['a', 'b'], 'b')).toEqual(['a', 'b']);
  });

  it('returns just the pinned tabs when there is no preview', () => {
    expect(combinedTabs(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('scrollTabsWithWheel', () => {
  function wheelEvent(deltaY: number, deltaX: number, overflowing: boolean) {
    const scroller = document.createElement('div');
    setOverflowing(scroller, overflowing);
    scroller.scrollLeft = 0;
    const preventDefault = vi.fn();
    return {
      event: {
        deltaY,
        deltaX,
        currentTarget: scroller,
        preventDefault,
      } as unknown as React.WheelEvent<HTMLDivElement>,
      scroller,
      preventDefault,
    };
  }

  it('converts a vertical wheel gesture into horizontal scroll when the strip overflows', () => {
    const { event, scroller, preventDefault } = wheelEvent(40, 0, true);
    scrollTabsWithWheel(event);
    expect(scroller.scrollLeft).toBe(40);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('does nothing when the strip does not overflow', () => {
    const { event, scroller, preventDefault } = wheelEvent(40, 0, false);
    scrollTabsWithWheel(event);
    expect(scroller.scrollLeft).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('leaves a primarily-horizontal gesture untouched', () => {
    const { event, scroller, preventDefault } = wheelEvent(10, 40, true);
    scrollTabsWithWheel(event);
    expect(scroller.scrollLeft).toBe(0);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('useTabStrip — overflow via ResizeObserver', () => {
  it('reports overflow once the ResizeObserver callback sees the strip no longer fits', () => {
    const getSnapshot = () => ({ openTabIds: ['a'], previewTabId: null, activeTabId: 'a' });
    render(
      <Harness
        openTabIds={['a']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={vi.fn()}
      />,
    );
    const scroller = screen.getByTestId('scroller');
    expect(screen.getByTestId('overflows').textContent).toBe('false');

    setOverflowing(scroller, true);
    fireEvent.click(screen.getByText('open dropdown'));
    expect(screen.getByTestId('dropdown-open').textContent).toBe('true');

    act(() => ResizeObserverStub.instances[0].trigger());
    expect(screen.getByTestId('overflows').textContent).toBe('true');
  });

  it('closes an open dropdown as soon as the strip stops overflowing', () => {
    const getSnapshot = () => ({ openTabIds: ['a'], previewTabId: null, activeTabId: 'a' });
    render(
      <Harness
        openTabIds={['a']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={vi.fn()}
      />,
    );
    const scroller = screen.getByTestId('scroller');

    setOverflowing(scroller, true);
    act(() => ResizeObserverStub.instances[0].trigger());
    expect(screen.getByTestId('overflows').textContent).toBe('true');
    fireEvent.click(screen.getByText('open dropdown'));
    expect(screen.getByTestId('dropdown-open').textContent).toBe('true');

    setOverflowing(scroller, false);
    act(() => ResizeObserverStub.instances[0].trigger());
    expect(screen.getByTestId('overflows').textContent).toBe('false');
    expect(screen.getByTestId('dropdown-open').textContent).toBe('false');
  });

  it('disconnects the observer on unmount', () => {
    const getSnapshot = () => ({ openTabIds: ['a'], previewTabId: null, activeTabId: 'a' });
    const { unmount } = render(
      <Harness
        openTabIds={['a']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={vi.fn()}
      />,
    );
    const instance = ResizeObserverStub.instances[0];
    unmount();
    expect(instance.disconnect).toHaveBeenCalled();
  });
});

describe('useTabStrip — Alt+Arrow keyboard navigation', () => {
  it('activates the next tab on Alt+ArrowRight, wrapping to the first tab past the end', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({
      openTabIds: ['a', 'b', 'c'],
      previewTabId: null,
      activeTabId: 'c',
    });
    render(
      <Harness
        openTabIds={['a', 'b', 'c']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true });

    expect(setActiveTab).toHaveBeenCalledWith('a');
  });

  it('activates the previous tab on Alt+ArrowLeft, wrapping to the last tab before the start', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({
      openTabIds: ['a', 'b', 'c'],
      previewTabId: null,
      activeTabId: 'a',
    });
    render(
      <Harness
        openTabIds={['a', 'b', 'c']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true });

    expect(setActiveTab).toHaveBeenCalledWith('c');
  });

  it('includes the temporary preview tab in the navigation order', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({ openTabIds: ['a'], previewTabId: 'preview', activeTabId: 'a' });
    render(
      <Harness
        openTabIds={['a']}
        previewTabId="preview"
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true });

    expect(setActiveTab).toHaveBeenCalledWith('preview');
  });

  it('does nothing with fewer than two tabs', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({ openTabIds: ['a'], previewTabId: null, activeTabId: 'a' });
    render(
      <Harness
        openTabIds={['a']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true });

    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it('ignores Arrow keys without the Alt modifier', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({ openTabIds: ['a', 'b'], previewTabId: null, activeTabId: 'a' });
    render(
      <Harness
        openTabIds={['a', 'b']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    fireEvent.keyDown(document, { key: 'ArrowRight' });

    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it('removes the keydown listener on unmount', () => {
    const setActiveTab = vi.fn();
    const getSnapshot = () => ({ openTabIds: ['a', 'b'], previewTabId: null, activeTabId: 'a' });
    const { unmount } = render(
      <Harness
        openTabIds={['a', 'b']}
        previewTabId={null}
        getSnapshot={getSnapshot}
        setActiveTab={setActiveTab}
      />,
    );

    unmount();
    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true });

    expect(setActiveTab).not.toHaveBeenCalled();
  });
});
