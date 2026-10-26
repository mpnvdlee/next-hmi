import '@shared/styles/blockingOverlay.css';
import { useEffect, useState } from 'react';
import { useVariableStore } from '@hmi/store/variableStore';
import Spinner from '@shared/components/Spinner';

interface Props {
  /** Shown in a card under the title; without one only the title and spinner show. */
  message?: string;
}

/**
 * Blurs the page with a spinner while the server connection is down. Only a
 * drop shows it: the page is still booting before the first connect, so that
 * wait is the boot screen's to show.
 */
export default function ConnectionLostOverlay({ message }: Props) {
  const [lost, setLost] = useState(false);

  useEffect(
    () =>
      useVariableStore.subscribe((state, prev) => {
        if (state.wsConnected !== prev.wsConnected) setLost(!state.wsConnected);
      }),
    [],
  );

  if (!lost) return null;
  if (!message) {
    return (
      <div className="blocking-overlay blocking-overlay--blur blocking-overlay--plain" role="alert">
        <Spinner />
        Connection lost
      </div>
    );
  }
  return (
    <div
      className="blocking-overlay blocking-overlay--blur"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-lost-title"
    >
      <div className="name-modal blocking-overlay__dialog">
        <h2 className="name-modal__title" id="connection-lost-title">
          Connection lost
        </h2>
        <div className="name-modal__message blocking-overlay__busy">
          <Spinner variant="cfg" size="sm" />
          {message}
        </div>
      </div>
    </div>
  );
}
