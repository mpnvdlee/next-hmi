import { useEffect, useState } from 'react';

import { subscribeConfigChanged } from '@shared/events/configChangedBus';

import './ConfigUpdatedBanner.css';

export function ConfigUpdatedBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return subscribeConfigChanged((event) => {
      if (event.source !== 'mcp') return;
      setVisible(true);
    });
  }, []);

  if (!visible) return null;
  return (
    <div className="config-updated-banner" role="status" aria-live="polite">
      <span className="config-updated-banner__msg">Config was updated by another writer.</span>
      <button
        type="button"
        className="config-updated-banner__btn config-updated-banner__btn--primary"
        onClick={() => window.location.reload()}
      >
        Reload page
      </button>
      <button
        type="button"
        className="config-updated-banner__btn"
        onClick={() => setVisible(false)}
      >
        Keep unsaved changes
      </button>
    </div>
  );
}
