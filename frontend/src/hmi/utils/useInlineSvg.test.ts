import { renderHook, waitFor } from '@testing-library/react';
import { useInlineSvg } from './useInlineSvg';

function mockFetchOnce(text: string) {
  return vi.fn().mockResolvedValue({ text: async () => text });
}

describe('useInlineSvg', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns an empty string when no url is given', () => {
    const { result } = renderHook(() => useInlineSvg(undefined));
    expect(result.current).toBe('');
  });

  it('fetches the url and strips hardcoded colors, injecting a currentColor style', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        '<svg viewBox="0 0 10 10" fill="#ff0000" stroke="#00ff00"><path d="M0 0" /></svg>',
      ),
    );
    const { result } = renderHook(() => useInlineSvg('/icons/gear.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).not.toContain('fill="#ff0000"');
    expect(result.current).not.toContain('stroke="#00ff00"');
    expect(result.current).toContain('fill:currentColor');
  });

  it('resolves to an empty string when the fetched text has no <svg> element', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('<html><body>not an icon</body></html>'));
    const { result, rerender } = renderHook(() => useInlineSvg('/icons/broken.svg'));

    await waitFor(() => {
      rerender();
      expect(result.current).toBe('');
    });
  });

  it('silently ignores a rejected fetch (no crash, content stays empty)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { result } = renderHook(() => useInlineSvg('/icons/gear.svg'));

    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBe('');
  });

  it('discards a stale in-flight response after the url changes', async () => {
    let resolveFirst!: (value: { text: () => Promise<string> }) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ text: async () => '<svg><path d="second" /></svg>' });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ url }) => useInlineSvg(url), {
      initialProps: { url: '/icons/first.svg' },
    });

    rerender({ url: '/icons/second.svg' });
    await waitFor(() => expect(result.current).toContain('second'));

    resolveFirst({ text: async () => '<svg><path d="first" /></svg>' });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current).toContain('second');
    expect(result.current).not.toContain('first');
  });

  it('does not throw when the component unmounts before the fetch resolves', async () => {
    let resolveFetch!: (value: { text: () => Promise<string> }) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const { unmount } = renderHook(() => useInlineSvg('/icons/gear.svg'));
    unmount();

    expect(() => resolveFetch({ text: async () => '<svg></svg>' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('re-fetches the same url on every mount (no caching across mounts)', async () => {
    const fetchMock = mockFetchOnce('<svg></svg>');
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();

    renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
