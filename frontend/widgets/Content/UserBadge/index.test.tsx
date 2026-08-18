import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import UserBadge from './index';

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
    useHmiStore.setState({ currentUsersByScope: {} });
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
});
