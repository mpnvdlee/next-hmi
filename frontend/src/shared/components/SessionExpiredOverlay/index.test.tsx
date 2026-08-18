import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SessionExpiredOverlay from './index';
import { useSessionStore } from '@shared/store/sessionStore';

afterEach(() => useSessionStore.setState({ managerSessionExpired: false }));

describe('SessionExpiredOverlay', () => {
  it('stays out of the way while the session holds', () => {
    render(<SessionExpiredOverlay />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('explains the empty project once the manager session is gone', () => {
    useSessionStore.getState().markManagerSessionExpired();
    render(<SessionExpiredOverlay />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Signed out');
    // The shared modal card, so it matches every other dialog in the app.
    expect(dialog.querySelector('.name-modal')).not.toBeNull();
  });

  it('sends the operator to the manager sign-in, carrying this URL back', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
      pathname: '/editor/p1/config',
      search: '',
    } as unknown as Location);
    useSessionStore.getState().markManagerSessionExpired();
    render(<SessionExpiredOverlay />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(assign).toHaveBeenCalledWith('/?signIn=%2Feditor%2Fp1%2Fconfig');
  });
});
