import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContactPrompt from './index';
import type { TelemetryStatus } from '../TelemetrySection';

const ID = 'c'.repeat(32);

function renderPrompt(overrides: Partial<TelemetryStatus> = {}) {
  const onDismiss = vi.fn().mockResolvedValue(undefined);
  const status: TelemetryStatus = {
    enabled: true,
    envOverride: null,
    installId: ID,
    contactPrompt: true,
    ...overrides,
  };
  const { container } = render(<ContactPrompt status={status} onDismiss={onDismiss} />);
  return { container, onDismiss };
}

describe('ContactPrompt', () => {
  it('stays away until the backend says this installation is past trying it out', () => {
    const { container } = renderPrompt({ contactPrompt: false });
    expect(container).toBeEmptyDOMElement();
  });

  it('links to the contact form with the installation ID while reports are sent', () => {
    renderPrompt();
    const link = screen.getByRole('link', { name: /Tell us about it/ });
    expect(link).toHaveAttribute('href', `https://next-hmi.com/contact?from=app&install=${ID}`);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves the ID out when reporting is off — it would match nothing', () => {
    renderPrompt({ enabled: false });
    expect(screen.getByRole('link', { name: /Tell us about it/ })).toHaveAttribute(
      'href',
      'https://next-hmi.com/contact?from=app',
    );
    expect(screen.queryByText(/ID filled in/)).not.toBeInTheDocument();
  });

  it('points at what shipping it costs', () => {
    renderPrompt();
    expect(screen.getByRole('link', { name: /What you owe when you ship it/ })).toHaveAttribute(
      'href',
      'https://next-hmi.com/pricing?from=contact-prompt#situations',
    );
  });

  it('is dismissed by "Not now" and by following the link', async () => {
    const { onDismiss } = renderPrompt();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const link = screen.getByRole('link', { name: /Tell us about it/ });
    // jsdom would try to navigate; the handler is what is under test.
    link.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(link);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
