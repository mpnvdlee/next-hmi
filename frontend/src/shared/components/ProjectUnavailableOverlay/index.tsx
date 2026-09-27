import '@shared/styles/blockingOverlay.css';
import Button from '@config/components/ui/Button';
import {
  useProjectAvailabilityStore,
  type UnavailableReason,
} from '@shared/store/projectAvailabilityStore';
import { projectSlug } from '@shared/utils/runtimeBase';

/**
 * Blocking notice for a project document whose instance is not there.
 *
 * The manager serves this document itself when it cannot proxy to a child (see
 * `_proxy_http_to_child`), so the app boots with no backend of its own: every
 * call 503s and the editor would otherwise mount over nothing, which reads as
 * "the project is empty" rather than "the project is not running". Sibling of
 * `SessionExpiredOverlay` — same shell, same reason for existing, different
 * cause — so it shares the blocking-overlay style rather than restating it.
 */
const MESSAGES: Record<UnavailableReason, string> = {
  stopped: 'It is not running. Start it from the projects page to open it.',
  crashed: 'The instance crashed. Start it again from the projects page to see the failure.',
  missing:
    'Its project folder is missing. Use Locate on the projects page to point it at the folder.',
  unknown: 'No project with that id is registered on this device.',
};

export default function ProjectUnavailableOverlay() {
  const reason = useProjectAvailabilityStore((s) => s.reason);
  const name = useProjectAvailabilityStore((s) => s.projectName);
  if (!reason) return null;
  const label = name ?? projectSlug() ?? 'This project';
  return (
    <div
      className="blocking-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="project-unavailable-title"
    >
      <div className="name-modal blocking-overlay__dialog">
        <h2 className="name-modal__title" id="project-unavailable-title">
          Can&rsquo;t open {label}
        </h2>
        <div className="name-modal__message">{MESSAGES[reason]}</div>
        <div className="name-modal__actions">
          <Button variant="primary" onClick={() => window.location.assign('/projects')}>
            Go to projects
          </Button>
        </div>
      </div>
    </div>
  );
}
