import '@testing-library/jest-dom';

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
