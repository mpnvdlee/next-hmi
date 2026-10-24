import Button from '@config/components/ui/Button';
import type { TelemetryStatus } from '../TelemetrySection';
import { contactUrl } from '../TelemetrySection/contactUrl';
import './style.css';

interface Props {
  status: TelemetryStatus | null;
  onDismiss(): Promise<void>;
}

/**
 * One-time question on the dashboard of an installation that is past trying
 * NEXT HMI out — the backend decides when, through `status.contactPrompt`.
 * It only links: the app itself sends nothing, and the installation ID reaches
 * next-hmi.com only if the reader submits the form the link opens.
 */
export default function ContactPrompt({ status, onDismiss }: Props) {
  if (!status?.contactPrompt) return null;

  // A failed dismiss leaves the card standing, which is its own error message.
  const dismiss = () => void onDismiss().catch(() => undefined);

  return (
    <section className="cfg-contact-prompt">
      <div className="cfg-contact-prompt__body">
        <h2 className="cfg-contact-prompt__title">Using NEXT HMI in a machine or product?</h2>
        <p className="cfg-contact-prompt__text">
          We would like to hear what you are building. A short conversation helps decide what comes
          next, and you get a direct line to the people who make it.
        </p>
        <p className="cfg-contact-prompt__note">
          Opens next-hmi.com in your browser
          {status.enabled ? " with this installation's ID filled in" : ''}. Nothing is sent until
          you submit the form.
        </p>
      </div>
      <div className="cfg-contact-prompt__actions">
        <Button variant="ghost" onClick={dismiss}>
          Not now
        </Button>
        <a
          className="cfg-btn cfg-btn--primary cfg-contact-prompt__link"
          href={contactUrl(status)}
          target="_blank"
          // noreferrer: the manager's own address is nobody's business at the far end.
          rel="noopener noreferrer"
          onClick={dismiss}
        >
          Tell us about it <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}
