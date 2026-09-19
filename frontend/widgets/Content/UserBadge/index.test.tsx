import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import UserBadge from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

// The sign-in and sign-out glyphs are code-split Phosphor icons: a `React.lazy`
// over a dynamic import of the whole 130-icon module, which `act` waits on —
// seconds under a loaded CPU, past the 5s test timeout. Nothing here asserts
// which glyph renders (the Icon widget's own test covers the real loader).
vi.mock('@shared/utils/phosphorIconComponents', () => ({
  BUILTIN_ICON_COMPONENTS: { lock: () => <svg />, 'sign-out': () => <svg /> },
}));

function renderBadge(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <UserBadge properties={properties} />
    </MemoryRouter>,
  );
}

function signIn(username: string, groups: string[], groupLabels: Record<string, string>) {
  useHmiStore.setState({
    currentUsersByScope: { 'runtime:preview': { username, groups, groupLabels } },
  });
}

describe('UserBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useHmiStore.setState({ currentUsersByScope: {}, openDialogs: [] });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders without throwing on empty properties', () => {
    const { container } = renderBadge({});
    expect(container.firstElementChild).not.toBeNull();
  });

  it('carries the base component class alongside its own', () => {
    const { container } = renderBadge({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.classList.contains('hmi-component')).toBe(true);
    expect(el.classList.contains('hmi-user-badge')).toBe(true);
  });

  it('renders the signed-in user and their groups', () => {
    signIn('L. Vesterå', ['ops'], { ops: 'Operators' });
    const { container } = renderBadge({});

    expect(screen.getByText('L. Vesterå')).toBeInTheDocument();
    expect(screen.getByText('Operators')).toBeInTheDocument();
    expect(container.querySelector('.hmi-user-badge__avatar')?.textContent).toBe('LV');
  });

  it('falls back to guest when nobody is signed in', () => {
    const { container } = renderBadge({});

    expect(screen.getAllByText('guest')).toHaveLength(2);
    expect(container.querySelector('.hmi-user-badge__avatar')?.textContent).toBe('G');
  });

  it('lets the schema text properties override the signed-in identity', () => {
    signIn('operator', ['ops'], { ops: 'Operators' });
    renderBadge({ usernameText: 'Shift lead', groupsText: 'Line 4' });

    expect(screen.getByText('Shift lead')).toBeInTheDocument();
    expect(screen.getByText('Line 4')).toBeInTheDocument();
    expect(screen.queryByText('operator')).toBeNull();
  });

  it('hides the group line when Show groups is off', () => {
    signIn('operator', ['ops'], { ops: 'Operators' });
    renderBadge({ showGroups: false });

    expect(screen.getByText('operator')).toBeInTheDocument();
    expect(screen.queryByText('Operators')).toBeNull();
  });

  describe('sign-in affordance', () => {
    const OPEN_LOGIN = { onSignIn: [{ type: 'openDialog', dialogId: 'login' }] };

    it('replaces the guest identity once sign-in actions are configured', () => {
      const { container } = renderBadge({ onSignIn: OPEN_LOGIN });

      expect(container.querySelector('.hmi-user-badge__signin')).not.toBeNull();
      expect(container.querySelector('.hmi-user-badge__avatar')).toBeNull();
      expect(screen.getByText('Log in')).toBeInTheDocument();
    });

    it('still shows the sign-in affordance when usernameText overrides the guest label', () => {
      const { container } = renderBadge({ usernameText: 'Welcome', onSignIn: OPEN_LOGIN });

      expect(container.querySelector('.hmi-user-badge__signin')).not.toBeNull();
      expect(screen.getByText('Log in')).toBeInTheDocument();
    });

    it('takes its label from the schema', () => {
      renderBadge({ signInLabel: 'Aanmelden', onSignIn: OPEN_LOGIN });

      expect(screen.getByText('Aanmelden')).toBeInTheDocument();
    });

    it('stays hidden for a signed-in user', () => {
      signIn('operator', ['ops'], { ops: 'Operators' });
      const { container } = renderBadge({ onSignIn: OPEN_LOGIN });

      expect(container.querySelector('.hmi-user-badge__signin')).toBeNull();
      expect(container.querySelector('.hmi-user-badge__avatar')?.textContent).toBe('O');
    });

    it('dispatches its actions when pressed', async () => {
      renderBadge({ onSignIn: OPEN_LOGIN });

      await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

      expect(useHmiStore.getState().openDialogs.map((d) => d.id)).toContain('login');
    });
  });

  describe('sign-out affordance', () => {
    it('appears for a signed-in user once sign-out actions are configured', () => {
      signIn('operator', ['ops'], { ops: 'Operators' });
      const { container } = renderBadge({ onSignOut: { onSignOut: [{ type: 'logoutUser' }] } });

      expect(container.querySelector('.hmi-user-badge__signout')).not.toBeNull();
    });

    it('stays hidden for guest', () => {
      const { container } = renderBadge({ onSignOut: { onSignOut: [{ type: 'logoutUser' }] } });

      expect(container.querySelector('.hmi-user-badge__signout')).toBeNull();
    });

    it('logs the user out when pressed', async () => {
      signIn('operator', ['ops'], { ops: 'Operators' });
      renderBadge({ onSignOut: { onSignOut: [{ type: 'logoutUser' }] } });

      await userEvent.click(screen.getByLabelText('Log out'));

      expect(vi.mocked(sendWsMessage).mock.calls[0][0]).toMatchObject({ type: 'logout' });
    });
  });

  it('only makes the identity pressable when On Press actions exist', () => {
    signIn('operator', ['ops'], { ops: 'Operators' });
    const plain = renderBadge({});
    expect(plain.container.querySelector('.hmi-user-badge__identity--pressable')).toBeNull();
    plain.unmount();

    const pressable = renderBadge({ actions: { onPress: [{ type: 'logoutUser' }] } });
    expect(
      pressable.container.querySelector('.hmi-user-badge__identity--pressable'),
    ).not.toBeNull();
  });
});
