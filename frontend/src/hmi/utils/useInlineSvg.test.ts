import { renderHook, waitFor } from '@testing-library/react';
import { publishConfigChanged } from '@shared/events/configChangedBus';
import { useInlineSvg } from './useInlineSvg';

function mockFetchOnce(text: string) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => text });
}

function forgetCachedAssets() {
  publishConfigChanged({ artifact_type: 'asset', artifact_ids: [], source: 'mcp', summary: '' });
}

describe('useInlineSvg', () => {
  afterEach(() => {
    forgetCachedAssets();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns an empty string when no url is given', () => {
    const { result } = renderHook(() => useInlineSvg(undefined));
    expect(result.current).toBe('');
  });

  it('fetches the url and repoints hardcoded colors at currentColor', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        '<svg viewBox="0 0 10 10" fill="#ff0000" stroke="#00ff00"><path d="M0 0" /></svg>',
      ),
    );
    const { result } = renderHook(() => useInlineSvg('/icons/gear.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).not.toContain('#ff0000');
    expect(result.current).not.toContain('#00ff00');
    expect(result.current).toContain('fill="currentColor"');
    expect(result.current).toContain('stroke="currentColor"');
  });

  it('keeps a stroke-outline icon stroked instead of flattening it into a fill', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        '<svg viewBox="0 0 48 48" fill="none"><path d="M9 17h24" stroke="#112233" stroke-width="3" /></svg>',
      ),
    );
    const { result } = renderHook(() => useInlineSvg('/icons/cup.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).toContain('fill="none"');
    expect(result.current).toContain('stroke="currentColor"');
    expect(result.current).not.toContain('stroke:none');
    expect(result.current).not.toContain('#112233');
  });

  it('gives an icon that declares no paint a currentColor fill', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('<svg viewBox="0 0 10 10"><path d="M0 0" /></svg>'));
    const { result } = renderHook(() => useInlineSvg('/icons/plain.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).toContain('fill="currentColor"');
  });

  it('repoints fill and stroke declared in an inline style attribute', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce(
        '<svg viewBox="0 0 10 10"><path style="fill:#ff0000;stroke:none" d="M0 0" /></svg>',
      ),
    );
    const { result } = renderHook(() => useInlineSvg('/icons/styled.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).toContain('fill:currentColor');
    expect(result.current).toContain('stroke:none');
    expect(result.current).not.toContain('#ff0000');
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
    let resolveFirst!: (value: { ok: boolean; text: () => Promise<string> }) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="second" /></svg>' });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ url }) => useInlineSvg(url), {
      initialProps: { url: '/icons/first.svg' },
    });

    rerender({ url: '/icons/second.svg' });
    await waitFor(() => expect(result.current).toContain('second'));

    resolveFirst({ ok: true, text: async () => '<svg><path d="first" /></svg>' });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current).toContain('second');
    expect(result.current).not.toContain('first');
  });

  it('does not throw when the component unmounts before the fetch resolves', async () => {
    let resolveFetch!: (value: { ok: boolean; text: () => Promise<string> }) => void;
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

    expect(() => resolveFetch({ ok: true, text: async () => '<svg></svg>' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('shows an icon fetched earlier on the first render of a later mount', async () => {
    const fetchMock = mockFetchOnce('<svg><path d="gear" /></svg>');
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(first.result.current).toContain('gear'));
    first.unmount();

    const second = renderHook(() => useInlineSvg('/icons/gear.svg'));
    expect(second.result.current).toContain('gear');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch between icons that mount together', async () => {
    const fetchMock = mockFetchOnce('<svg><path d="gear" /></svg>');
    vi.stubGlobal('fetch', fetchMock);

    const a = renderHook(() => useInlineSvg('/icons/gear.svg'));
    const b = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(a.result.current).toContain('gear'));
    await waitFor(() => expect(b.result.current).toContain('gear'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again after a failed fetch instead of caching the failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, text: async () => 'Not Found' })
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="gear" /></svg>' });
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(first.result.current).toBe('');
    first.unmount();

    const second = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(second.result.current).toContain('gear'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches again after an asset change is announced', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="old" /></svg>' })
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="new" /></svg>' });
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(first.result.current).toContain('old'));
    first.unmount();

    forgetCachedAssets();
    const second = renderHook(() => useInlineSvg('/icons/gear.svg'));
    await waitFor(() => expect(second.result.current).toContain('new'));
  });
});
