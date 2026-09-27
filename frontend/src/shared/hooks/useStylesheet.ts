/** One in-flight-or-settled load per href. Its presence is also what says the
 *  link is already in `<head>`. */
const loads = new Map<string, Promise<void>>();

/** Cap on how long one stylesheet holds a reveal. Deliberately under the page
 *  gate's own `MODULES_WAIT_MS`: a widget's `lazy()` awaits this and its
 *  Suspense fallback is `null`, so a link firing neither `load` nor `error`
 *  would leave the widget invisible on a page the gate had already revealed. */
export const STYLESHEET_WAIT_MS = 3000;

function linkFor(href: string): Element | null {
  return document.head.querySelector(`link[data-dynamic-stylesheet="${CSS.escape(href)}"]`);
}

/** Inject the link if it is not already there, and hand back the one promise
 *  that says when the browser has it. */
function inject(href: string): Promise<void> {
  const existing = loads.get(href);
  if (existing) return existing;

  const load = new Promise<void>((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset['dynamicStylesheet'] = href;

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, STYLESHEET_WAIT_MS);
    link.addEventListener('load', settle);
    link.addEventListener('error', settle);

    document.head.appendChild(link);
  });

  loads.set(href, load);
  return load;
}

/**
 * Injects a widget's `<link rel="stylesheet">` into `<head>` and resolves once
 * the browser has it — so a caller can hold a reveal until the CSS is in the
 * CSSOM rather than letting the widget paint unstyled first.
 *
 * Resolves on `error` as well as `load`, matching the rule the module prefetch
 * follows: a widget whose stylesheet 404s must not hold a page behind its
 * spinner.
 *
 * The link has the module's lifetime, not a mount's — nothing removes it when
 * the last instance unmounts, so a revisited page is never unstyled again.
 */
export function ensureStylesheet(href: string): Promise<void> {
  return inject(href);
}

/** Drop a stylesheet. Called when a recompile supersedes a build — and only
 *  once the replacement has landed, so mounted instances never sit between two
 *  stylesheets. */
export function releaseStylesheet(href: string): void {
  loads.delete(href);
  linkFor(href)?.remove();
}
