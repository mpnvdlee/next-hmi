import { useEffect, useState } from 'react';
import { subscribeConfigChanged } from '@shared/events/configChangedBus';
import { loadConfigIndex } from '@shared/hooks/useConfig';
import { useTranslationStore } from '@shared/store/translationStore';

/**
 * Keeps the operator screen in step with edits made by another writer, such
 * as an AI assistant over MCP. Pages and translations are cached in the
 * stores, so without this a new widget, page or text only shows after a
 * browser reload.
 *
 * Returns a counter that ticks after each page reload, so the caller can
 * re-send its runtime context for variables a new widget binds.
 */
export function useLivePageReload(): number {
  const [reloads, setReloads] = useState(0);
  useEffect(
    () =>
      subscribeConfigChanged((event) => {
        // The index carries every page document plus globalEvents, so one
        // re-fetch covers widget edits, metadata, created and deleted pages.
        if (event.artifact_type === 'page') {
          void loadConfigIndex().then(() => setReloads((n) => n + 1));
        } else if (event.artifact_type === 'translations') {
          void useTranslationStore.getState().loadTranslations({ force: true });
        }
      }),
    [],
  );
  return reloads;
}
