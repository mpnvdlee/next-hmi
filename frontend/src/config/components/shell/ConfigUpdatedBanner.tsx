import { useEffect, useState } from 'react';

import { subscribeConfigChanged } from '@shared/events/configChangedBus';
import { subscribeWidgetUpdated } from '@shared/events/widgetUpdatedBus';
import { TAB_ID } from '@shared/utils/api';
import { forgetInlineSvgs } from '@hmi/utils/useInlineSvg';
import { editorHasUnsavedChanges, heldDomain, reloadEditor } from '@config/utils/editorLiveSync';

import './ConfigUpdatedBanner.css';

/**
 * Applies another writer's change to an editor with nothing unsaved, in place,
 * and warns one with unsaved edits instead — reloading would drop them, and
 * saving them unseen would overwrite the change. A change this tab saved
 * itself carries its `TAB_ID` and is skipped. A recompiled custom widget is
 * handled the same way, by a page reload.
 */
const CHANGED_ELSEWHERE = 'Config was updated by another writer.';
const WIDGET_RECOMPILED = 'A custom widget was recompiled. Reload to use it.';

export function ConfigUpdatedBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    return subscribeConfigChanged((event) => {
      if (event.tab_id === TAB_ID) return;
      // A cache, not something an author edits: forgetting it never costs an edit.
      if (event.artifact_type === 'asset') forgetInlineSvgs();
      const domain = heldDomain(event.artifact_type);
      if (!domain) return;
      if (editorHasUnsavedChanges()) {
        setMessage(CHANGED_ELSEWHERE);
        return;
      }
      void reloadEditor(event.artifact_type, domain).then((applied) => {
        // An edit landed during the fetch and the change was left out: say so.
        if (!applied) setMessage(CHANGED_ELSEWHERE);
      });
    });
  }, []);

  // A recompiled custom widget: the new module only loads with the page, so
  // reload when nothing would be lost, and warn otherwise. The preview iframe
  // reloads itself either way (PreviewView).
  useEffect(() => {
    return subscribeWidgetUpdated(() => {
      if (editorHasUnsavedChanges()) setMessage(WIDGET_RECOMPILED);
      else window.location.reload();
    });
  }, []);

  if (!message) return null;
  return (
    <div className="config-updated-banner" role="status">
      <span className="config-updated-banner__msg">{message}</span>
      <button
        type="button"
        className="config-updated-banner__btn config-updated-banner__btn--primary"
        onClick={() => window.location.reload()}
      >
        Reload page
      </button>
      <button type="button" className="config-updated-banner__btn" onClick={() => setMessage(null)}>
        Keep unsaved changes
      </button>
    </div>
  );
}
