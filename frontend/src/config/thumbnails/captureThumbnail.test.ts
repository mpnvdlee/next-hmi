import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { captureThumbnail } from './captureThumbnail';

vi.mock('modern-screenshot', () => ({
  domToBlob: vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' })),
}));

async function mountedFrame(): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const el = document.querySelector('iframe[data-thumbnail-capture]');
    if (!el) throw new Error('iframe not mounted yet');
    return el as HTMLIFrameElement;
  });
}

/** Adds the `.hmi-layout` element the code looks up, then delivers the real
 *  `preview_ready` handshake `waitForPreviewReady` listens for — a message
 *  whose `source` is genuinely this iframe's `contentWindow`. */
function announceReady(frame: HTMLIFrameElement): HTMLElement {
  // jsdom never navigates the iframe, so its contentDocument has no
  // documentElement/body — append the target directly as the document's
  // one permitted root element.
  const doc = frame.contentDocument!;
  const hmiLayout = doc.createElement('div');
  hmiLayout.className = 'hmi-layout';
  doc.appendChild(hmiLayout);
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'preview_ready' }, source: frame.contentWindow }),
  );
  return hmiLayout;
}

describe('captureThumbnail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useConfigStore.setState({ pages: [], loadPageContent: vi.fn().mockResolvedValue(undefined) });
  });

  it('does nothing when the project has no pages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await captureThumbnail();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('captures the main page and uploads it once the preview reports ready', async () => {
    const { domToBlob } = await import('modern-screenshot');
    useConfigStore.setState({
      pages: [{ id: 'home', type: 'page', title: 'Home', sections: { content: [] } }] as never,
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const capture = captureThumbnail({ readyTimeoutMs: 5000 });
    const frame = await mountedFrame();
    const hmiLayout = announceReady(frame);

    await capture;

    // DOM nodes crash Vitest/chai's call-arg inspector once their iframe has
    // been torn down (the getter for a detached window's `.location` throws),
    // so assert identity directly on the recorded call args instead of
    // routing the element through `toHaveBeenCalledWith`.
    expect(domToBlob).toHaveBeenCalledTimes(1);
    const [target, screenshotOptions] = vi.mocked(domToBlob).mock.calls[0];
    expect(target).toBe(hmiLayout);
    expect(screenshotOptions).toEqual({
      width: 1280,
      height: 720,
      scale: 0.75,
      type: 'image/png',
      backgroundColor: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/thumbnail');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(init.body).toBeInstanceOf(Blob);
    expect((init.body as Blob).type).toBe('image/png');
  });

  it('resolves without throwing when the preview never becomes ready', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useConfigStore.setState({
      pages: [{ id: 'home', type: 'page', title: 'Home', sections: { content: [] } }] as never,
    });
    await expect(captureThumbnail({ readyTimeoutMs: 10 })).resolves.toBeUndefined();
    expect(document.querySelector('iframe[data-thumbnail-capture]')).toBeNull();
  });

  it('resolves without throwing when the upload fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useConfigStore.setState({
      pages: [{ id: 'home', type: 'page', title: 'Home', sections: { content: [] } }] as never,
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    const capture = captureThumbnail({ readyTimeoutMs: 5000 });
    const frame = await mountedFrame();
    announceReady(frame);

    await expect(capture).resolves.toBeUndefined();
  });

  it('warns when the upload is rejected by the server', async () => {
    useConfigStore.setState({
      pages: [{ id: 'home', type: 'page', title: 'Home', sections: { content: [] } }] as never,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 422 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const capture = captureThumbnail({ readyTimeoutMs: 5000 });
    const frame = await mountedFrame();
    announceReady(frame);

    await expect(capture).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('422'));
  });

  it('ignores a second capture while the first is still running', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useConfigStore.setState({
      pages: [{ id: 'home', type: 'page', title: 'Home', sections: { content: [] } }] as never,
    });
    const loadPageContentSpy = useConfigStore.getState().loadPageContent;
    const first = captureThumbnail({ readyTimeoutMs: 10 });
    const second = captureThumbnail({ readyTimeoutMs: 10 });
    await Promise.all([first, second]);
    expect(loadPageContentSpy).toHaveBeenCalledTimes(1);
  });
});
