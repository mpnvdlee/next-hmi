import '@shared/styles/blockingOverlay.css';
import { useEffect, useState } from 'react';
import { useVariableStore } from '@hmi/store/variableStore';
import Spinner from '@shared/components/Spinner';

interface Props {
  /** Shown in a card under the title; without one only the title and spinner show. */
  message?: string;
  /** Called once the connection is back after a drop. */
  onReturn?: () => void;
}

/**
 * Blurs the page with a spinner while the server connection is down. Only a
 * drop counts: the first connect of a page load is not a return, so the boot
 * never flashes it.
 */
export default function ConnectionLostOverlay({ message, onReturn }: Props) {
  const [lost, setLost] = useState(false);

  useEffect(() => {
    let dropped = false;
    return useVariableStore.subscribe((state, prev) => {
      if (state.wsConnected === prev.wsConnected) return;
      if (!state.wsConnected) {
        dropped = true;
        setLost(true);
      } else if (dropped) {
        dropped = false;
        setLost(false);
        onReturn?.();
      }
    });
  }, [onReturn]);

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
