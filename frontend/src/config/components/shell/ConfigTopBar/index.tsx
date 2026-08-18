import { type ReactNode } from 'react';
import { getArea } from '@shared/utils/runtimeBase';
import AppTopBarNav from '@shared/components/AppTopBarNav';
import Button from '@config/components/ui/Button';
import './style.css';

interface Props {
  children?: ReactNode;
  status?: ReactNode;
  /** Rendered in the left group, after the brand/project name and status. */
  leftContent?: ReactNode;
}

// The editor runs as a manager-proxied instance, so the manager session is the
// single sign-on for every non-runtime page. "Sign out" clears that session via
// the absolute origin endpoint (bypassing the editor's proxy base, like the rest
// of AppTopBarNav's manager calls) and returns to the dashboard. Hidden in dev,
// where there is no manager to sign out of.
async function handleSignOut() {
  try {
    await fetch('/api/manager/auth/logout', { method: 'POST' });
  } catch {
    /* ignore — navigate to the manager regardless */
  }
  window.location.assign('/projects');
}

export default function ConfigTopBar({ children, status, leftContent }: Props) {
  const managed = getArea() !== null;

  return (
    <header className="cfg-header">
      <div className="cfg-header__left">
        <AppTopBarNav />
        {status}
        {leftContent}
      </div>
      <div className="cfg-header__actions">
        {children}
        {/* Origin-absolute, never base-prefixed: /help is the manager's, not the
            project instance's — it serves the docs bundled with this build, or
            redirects to the public documentation page when none are bundled. */}
        <Button
          variant="ghost"
          title="Open the documentation"
          onClick={() => window.open('/help', '_blank', 'noopener')}
        >
          ? Help
        </Button>
        {managed && (
          <Button variant="ghost" onClick={handleSignOut}>
            Sign out
          </Button>
        )}
      </div>
    </header>
  );
}
