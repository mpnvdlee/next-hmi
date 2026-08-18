import './style.css';
import Button from '@config/components/ui/Button';
import { useSessionStore, managerSignInUrl } from '@shared/store/sessionStore';

/**
 * Blocking notice for a document whose manager session is gone.
 *
 * Without it the app keeps rendering its last (usually empty) state while every
 * request 401s, which reads as "the project is empty" rather than "you are
 * signed out". Built from the config modal primitives (`name-modal`, `Button`)
 * so it matches every other dialog; it does not reuse `ModalShell` because this
 * one is not dismissable and because pulling all of `config.css` into the
 * operator runtime for two overlay rules isn't worth it — same reason
 * `BootSplash` imports only the token layer.
 */
export default function SessionExpiredOverlay() {
  const expired = useSessionStore((s) => s.managerSessionExpired);
  if (!expired) return null;
  return (
    <div
      className="session-expired"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="name-modal session-expired__dialog">
        <h2 className="name-modal__title" id="session-expired-title">
          Signed out
        </h2>
        <div className="name-modal__message">
          This device&rsquo;s manager session is no longer valid, so the project cannot be loaded.
          Sign in with the device-admin password to continue.
        </div>
        <div className="name-modal__actions">
          <Button variant="primary" onClick={() => window.location.assign(managerSignInUrl())}>
            Sign in
          </Button>
        </div>
      </div>
    </div>
  );
}
