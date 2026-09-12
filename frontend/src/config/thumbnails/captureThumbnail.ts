import { syncAllTo } from '@config/components/editor/LivePreview/previewSync';
import { useConfigStore } from '@shared/store/configStore';
import { findFirstPage } from '@shared/utils/pageTree';
import { withBase } from '@shared/utils/runtimeBase';

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const THUMBNAIL_WIDTH = 480;
const SETTLE_MS = 700;

interface Options {
  readyTimeoutMs?: number;
}

// A save can trigger another before the first capture settles (e.g. two
// quick saves). Without this, the second call would spin up its own iframe
// and the two POSTs would race for which one's bytes end up stored.
let captureInFlight = false;

/**
 * Rasterise the project's main page and store it as this project's thumbnail.
 *
 * Deliberately drives a hidden `/preview/` iframe rather than `/runtime/`:
 * `HmiView` calls `useGlobalEvents`, so mounting the runtime would fire
 * `onHmiLoaded` and write to datasources on every save. `PreviewView` does not.
 *
 * Always resolves. A thumbnail is a nicety; a save is not.
 */
export async function captureThumbnail({ readyTimeoutMs = 8000 }: Options = {}): Promise<void> {
  const { pages, loadPageContent } = useConfigStore.getState();
  const mainPage = findFirstPage(pages);
  if (!mainPage) return;
  if (captureInFlight) return;
  captureInFlight = true;

  let frame: HTMLIFrameElement | null = null;
  try {
    await loadPageContent(mainPage.id);

    frame = document.createElement('iframe');
    frame.dataset.thumbnailCapture = 'true';
    frame.src = withBase(`/preview/${mainPage.id}`);
    // Offscreen rather than display:none — a hidden frame has no layout, and a
    // fixed size keeps framing identical regardless of the author's window,
    // which matters because the shell's $viewport bindings switch layout by
    // breakpoint.
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${CAPTURE_WIDTH}px;height:${CAPTURE_HEIGHT}px;border:0;`;
    document.body.appendChild(frame);

    await waitForPreviewReady(frame, readyTimeoutMs);

    syncAllTo((message) => frame?.contentWindow?.postMessage(message, window.location.origin), [
      mainPage.id,
    ]);
    await delay(SETTLE_MS);

    const target = frame.contentDocument?.querySelector('.hmi-layout');
    if (!target) return;

    const { domToBlob } = await import('modern-screenshot');
    const blob = await domToBlob(target as HTMLElement, {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      scale: (THUMBNAIL_WIDTH / CAPTURE_WIDTH) * 2,
      type: 'image/png',
      backgroundColor: null,
    });

    const response = await fetch(withBase('/api/thumbnail'), {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    if (!response.ok) {
      console.warn(`[captureThumbnail] upload rejected: ${response.status}`);
    }
  } catch (err) {
    console.error('[captureThumbnail] skipped:', err);
  } finally {
    frame?.remove();
    captureInFlight = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The preview discards messages sent before it mounts its listener, so the
 *  handshake is required rather than an optimisation. */
function waitForPreviewReady(frame: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('preview_ready timed out'));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== frame.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type !== 'preview_ready') return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve();
    }

    window.addEventListener('message', onMessage);
  });
}
