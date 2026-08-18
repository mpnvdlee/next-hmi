import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStylesheet } from './useStylesheet';

function linksFor(href: string): NodeListOf<HTMLLinkElement> {
  return document.head.querySelectorAll(`link[data-dynamic-stylesheet="${href}"]`);
}

describe('useStylesheet', () => {
  it('does nothing for a null/empty href', () => {
    const { unmount } = renderHook(() => useStylesheet(null));
    expect(document.head.querySelectorAll('link').length).toBe(0);
    unmount();
  });

  it('injects a single link, shared across two consumers of the same href', () => {
    const href = '/widgets/GaugeA/style.css';

    const first = renderHook(() => useStylesheet(href));
    expect(linksFor(href)).toHaveLength(1);

    const second = renderHook(() => useStylesheet(href));
    expect(linksFor(href)).toHaveLength(1);

    first.unmount();
    second.unmount();
  });

  it('keeps the link while at least one consumer remains, and removes it once the last unmounts', () => {
    const href = '/widgets/GaugeB/style.css';

    const first = renderHook(() => useStylesheet(href));
    const second = renderHook(() => useStylesheet(href));
    expect(linksFor(href)).toHaveLength(1);

    first.unmount();
    expect(linksFor(href)).toHaveLength(1);

    second.unmount();
    expect(linksFor(href)).toHaveLength(0);
  });

  it('removes the link only once all consumers of an href with 3+ mounts have unmounted', () => {
    const href = '/widgets/GaugeC/style.css';

    const a = renderHook(() => useStylesheet(href));
    const b = renderHook(() => useStylesheet(href));
    const c = renderHook(() => useStylesheet(href));
    expect(linksFor(href)).toHaveLength(1);

    a.unmount();
    expect(linksFor(href)).toHaveLength(1);
    b.unmount();
    expect(linksFor(href)).toHaveLength(1);
    c.unmount();
    expect(linksFor(href)).toHaveLength(0);
  });
});
