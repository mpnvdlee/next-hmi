import '@testing-library/jest-dom';
import { createElement } from 'react';

/**
 * Every builtin icon is a lazy import of the whole Phosphor module, and `act()`
 * waits for it: ~2 s on an idle machine, past the 5 s test timeout under a
 * busy full run. Tests only need *an* svg, so stub the module for all of them;
 * the Icon widget's own test unmocks it to cover the real loader.
 */
vi.mock('@shared/utils/phosphorIconComponents', async () => {
  const { BUILTIN_ICON_IDS } = await import('@shared/config/iconAllowlist');
  return {
    BUILTIN_ICON_COMPONENTS: Object.fromEntries(
      [...BUILTIN_ICON_IDS].map((id) => [id, () => createElement('svg', { 'data-icon': id })]),
    ),
  };
});

/**
 * jsdom never fetches an injected `<link rel="stylesheet">`, so it fires
 * neither `load` nor `error` and `ensureStylesheet` sits out its full timeout
 * in every test that renders a real widget. Answer for it here, the same way
 * `widgets/widgetModuleLoader.ts` answers the module fetch jsdom has no server
 * for.
 *
 * `suspendStylesheetAutoLoad()` turns it off for the tests that exercise the
 * real event handling — without it, the case for the timeout fallback would
 * pass because this fired `load`, not because the fallback works.
 */
let autoLoad = true;

export function suspendStylesheetAutoLoad(): () => void {
  autoLoad = false;
  return () => {
    autoLoad = true;
  };
}

new MutationObserver((records) => {
  if (!autoLoad) return;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof HTMLLinkElement && node.dataset['dynamicStylesheet']) {
        node.dispatchEvent(new Event('load'));
      }
    }
  }
}).observe(document.head, { childList: true });

/**
 * jsdom has no `IntersectionObserver`, and `SelectionDrawer`'s scroll-spy sets
 * one up on mount. Installed per test file rather than here at import, because
 * `WindowedContent` deliberately mounts everything when the API is absent: a
 * globally defined inert stub would switch every page-rendering test to
 * windowed behaviour and mount nothing.
 */
export function stubIntersectionObserver(): void {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error assigning a test stub
  global.IntersectionObserver = IntersectionObserverStub;
}
