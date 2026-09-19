import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InsecureConnectionNotice from './index';

afterEach(() => vi.unstubAllGlobals());

function renderNotice(path = '/projects') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <InsecureConnectionNotice />
    </MemoryRouter>,
  );
}

describe('InsecureConnectionNotice', () => {
  it('renders nothing on a secure context — HTTPS, or loopback over plain HTTP', () => {
    vi.stubGlobal('isSecureContext', true);

    const { container } = renderNotice();

    expect(container).toBeEmptyDOMElement();
  });

  it('states the exposure and points at the HTTPS setting on a plain-HTTP network address', () => {
    vi.stubGlobal('isSecureContext', false);

    renderNotice();

    expect(screen.getByText(/serving over the network without HTTPS/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn on HTTPS in Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('drops the link on the settings page, where the switch already is', () => {
    vi.stubGlobal('isSecureContext', false);

    renderNotice('/settings');

    expect(screen.getByText(/serving over the network without HTTPS/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('carries no dismiss control, so it stands until HTTPS is on', () => {
    vi.stubGlobal('isSecureContext', false);

    renderNotice();

    expect(screen.queryByRole('button')).toBeNull();
  });
});
