import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { suspendStylesheetAutoLoad } from '../../test-setup';
import { ensureStylesheet, releaseStylesheet, STYLESHEET_WAIT_MS } from './useStylesheet';

function linksFor(href: string): NodeListOf<HTMLLinkElement> {
  return document.head.querySelectorAll(`link[data-dynamic-stylesheet="${href}"]`);
}

describe('ensureStylesheet', () => {
  // This block is about the event handling itself, so the harness must not
  // answer for jsdom here — every case below drives its own outcome.
  let restoreAutoLoad: () => void;
  beforeEach(() => {
    restoreAutoLoad = suspendStylesheetAutoLoad();
  });
  afterEach(() => restoreAutoLoad());

  function fire(href: string, event: 'load' | 'error'): void {
    linksFor(href)[0].dispatchEvent(new Event(event));
  }

  it('resolves once the injected link has loaded', async () => {
    const href = '/widgets/PreloadA/style.css';

    const ready = ensureStylesheet(href);
    expect(linksFor(href)).toHaveLength(1);

    fire(href, 'load');
    await expect(ready).resolves.toBeUndefined();
  });

  it('shares one link and one promise across concurrent callers', async () => {
    const href = '/widgets/PreloadB/style.css';

    const first = ensureStylesheet(href);
    const second = ensureStylesheet(href);
    expect(linksFor(href)).toHaveLength(1);

    fire(href, 'load');
    await Promise.all([first, second]);
  });

  it('resolves rather than rejects when the stylesheet fails to load', async () => {
    // Same rule the module prefetch follows: a broken widget must not hold the
    // page behind the reveal spinner.
    const href = '/widgets/PreloadMissing/style.css';

    const ready = ensureStylesheet(href);
    fire(href, 'error');

    await expect(ready).resolves.toBeUndefined();
  });

  it('gives up on its own before the page gate does, so a silent link never hides the widget', async () => {
    // `lazy()` awaits this, and a widget's Suspense fallback is null. An href
    // that fires neither event would leave the widget permanently invisible on
    // a page the gate had already revealed.
    vi.useFakeTimers();
    try {
      const href = '/widgets/PreloadSilent/style.css';
      const ready = ensureStylesheet(href);

      await vi.advanceTimersByTimeAsync(STYLESHEET_WAIT_MS);
      await expect(ready).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-uses the settled link on a later ensure, so a revisit is not unstyled again', async () => {
    // A stylesheet pulled in with the module has the module's lifetime: the
    // module record stays `loaded` across a navigation, so the gate reveals
    // the second visit at once and would find the CSS gone.
    const href = '/widgets/PreloadD/style.css';

    const ready = ensureStylesheet(href);
    fire(href, 'load');
    await ready;

    await expect(ensureStylesheet(href)).resolves.toBeUndefined();
    expect(linksFor(href)).toHaveLength(1);
  });

  it('releases a stylesheet on request, and re-injects on the next ensure', async () => {
    const href = '/widgets/PreloadE/style.css';

    const first = ensureStylesheet(href);
    fire(href, 'load');
    await first;

    releaseStylesheet(href);
    expect(linksFor(href)).toHaveLength(0);

    const second = ensureStylesheet(href);
    expect(linksFor(href)).toHaveLength(1);
    fire(href, 'load');
    await second;
    releaseStylesheet(href);
  });
});
