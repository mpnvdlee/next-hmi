import { act, fireEvent, render } from '@testing-library/react';
import type { WidgetConfig } from '@shared/types/config';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { useComponentStore } from '@shared/store/componentStore';
import { PreviewSelectionContext } from '../context/PreviewSelectionContext';
import WindowedContent from './WindowedContent';

const makeItems = (n: number): WidgetConfig[] =>
  Array.from(
    { length: n },
    (_, i) => ({ id: `w${i}`, type: 'Button', name: 'Button' }) as WidgetConfig,
  );

const renderItem = (w: WidgetConfig) => <div key={w.id} className="hmi-component" data-id={w.id} />;

describe('WindowedContent', () => {
  const OriginalIO = globalThis.IntersectionObserver;
  afterEach(() => {
    globalThis.IntersectionObserver = OriginalIO;
  });

  it('renders items directly (no wrappers) below the threshold', () => {
    const { container } = render(<WindowedContent items={makeItems(3)} render={renderItem} />);
    expect(container.querySelectorAll('.hmi-window-item')).toHaveLength(0);
    expect(container.querySelectorAll('.hmi-component')).toHaveLength(3);
  });

  it('wraps items above the threshold', () => {
    const { container } = render(<WindowedContent items={makeItems(50)} render={renderItem} />);
    expect(container.querySelectorAll('.hmi-window-item')).toHaveLength(50);
  });

  it('mounts every widget when IntersectionObserver is unavailable (safe fallback)', () => {
    // @ts-expect-error — simulate an environment without IntersectionObserver
    delete globalThis.IntersectionObserver;
    const { container } = render(<WindowedContent items={makeItems(50)} render={renderItem} />);
    expect(container.querySelectorAll('.hmi-component')).toHaveLength(50);
    for (const item of container.querySelectorAll('.hmi-window-item')) {
      expect(item.getAttribute('data-windowed')).toBe('on');
    }
  });

  it('force-mounts only the window item whose subtree holds the selection', () => {
    // An inert IntersectionObserver: nothing mounts on its own, so we can see
    // that ONLY the selected item is force-mounted while the rest stay windowed
    // out — the editor-preview selection path.
    class InertIO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // @ts-expect-error — minimal stub for the test
    globalThis.IntersectionObserver = InertIO;

    const { container } = render(
      <PreviewSelectionContext.Provider value={new Set(['w5'])}>
        <WindowedContent items={makeItems(50)} render={renderItem} />
      </PreviewSelectionContext.Provider>,
    );

    const mounted = container.querySelectorAll('.hmi-component');
    expect(mounted).toHaveLength(1);
    expect(mounted[0].getAttribute('data-id')).toBe('w5');
    const selectedWrapper = mounted[0].closest('.hmi-window-item');
    expect(selectedWrapper?.getAttribute('data-windowed')).toBe('on');
  });

  it('force-mounts the item whose $component instance subtree holds the selection', () => {
    // The selected widget lives inside a $component instance, so its id is NOT
    // on the instance node's children — it must be resolved via the component
    // store. Force-mount should still find and mount the owning window item.
    useComponentStore.setState({
      components: [
        {
          id: 'cmp',
          name: 'cmp',
          children: [{ id: 'inner', type: 'Button', name: 'Button' }],
        } as unknown as ComponentDefinition,
      ],
      draftComponents: {},
    });
    class InertIO {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // @ts-expect-error — minimal stub for the test
    globalThis.IntersectionObserver = InertIO;

    const items: WidgetConfig[] = [
      ...makeItems(45),
      { id: 'ci', type: '$component:cmp', name: 'cmp' } as WidgetConfig,
    ];
    const { container } = render(
      <PreviewSelectionContext.Provider value={new Set(['inner'])}>
        <WindowedContent items={items} render={renderItem} />
      </PreviewSelectionContext.Provider>,
    );

    const mounted = container.querySelectorAll('.hmi-component');
    expect(mounted).toHaveLength(1);
    expect(mounted[0].getAttribute('data-id')).toBe('ci');
  });

  it('unmounts items that scroll out of view (bounded window)', () => {
    const callbacks = new Map<Element, (e: { isIntersecting: boolean }[]) => void>();
    class MockIO {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe(el: Element) {
        callbacks.set(el, this.cb);
      }
      unobserve(el: Element) {
        callbacks.delete(el);
      }
      disconnect() {}
    }
    // @ts-expect-error — controllable stub
    globalThis.IntersectionObserver = MockIO;

    const { container } = render(<WindowedContent items={makeItems(50)} render={renderItem} />);
    const first = container.querySelectorAll('.hmi-window-item')[0];
    act(() => callbacks.get(first)?.([{ isIntersecting: true }]));
    expect(first.querySelector('.hmi-component')).not.toBeNull();
    act(() => callbacks.get(first)?.([{ isIntersecting: false }]));
    expect(first.querySelector('.hmi-component')).toBeNull();
    expect(first.getAttribute('data-windowed')).toBe('off');
  });

  it('pins an interacted item mounted so scrolling it out keeps its state', () => {
    const callbacks = new Map<Element, (e: { isIntersecting: boolean }[]) => void>();
    class MockIO {
      constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {}
      observe(el: Element) {
        callbacks.set(el, this.cb);
      }
      unobserve(el: Element) {
        callbacks.delete(el);
      }
      disconnect() {}
    }
    // @ts-expect-error — controllable stub
    globalThis.IntersectionObserver = MockIO;

    const renderInput = (w: WidgetConfig) => (
      <input key={w.id} className="hmi-component" data-id={w.id} />
    );
    const { container } = render(<WindowedContent items={makeItems(50)} render={renderInput} />);
    const first = container.querySelectorAll('.hmi-window-item')[0];

    act(() => callbacks.get(first)?.([{ isIntersecting: true }]));
    const input = first.querySelector('input');
    expect(input).not.toBeNull();
    fireEvent.focusIn(input!);

    // Scroll it out — a pristine item would unmount, but this one is pinned.
    act(() => callbacks.get(first)?.([{ isIntersecting: false }]));
    expect(first.querySelector('input')).not.toBeNull();
    expect(first.getAttribute('data-windowed')).toBe('on');
  });
});
