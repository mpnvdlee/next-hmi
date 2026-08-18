import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectedRuntimesSection from './index';
import type { RuntimeSession } from '@config/store/adminViewStore';

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    clientId: 'c1',
    scope: 'runtime',
    username: 'operator',
    groups: ['operators', 'guest'],
    connectedAt: '2026-07-28T10:00:00Z',
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof ConnectedRuntimesSection>> = {}) {
  const onRefresh = vi.fn();
  const view = render(
    <ConnectedRuntimesSection
      runtimes={[]}
      loading={false}
      error={null}
      onRefresh={onRefresh}
      {...props}
    />,
  );
  return { ...view, onRefresh };
}

describe('ConnectedRuntimesSection', () => {
  it('reports an idle backend with no sessions', () => {
    renderSection();

    expect(screen.getByText('No active runtimes.')).toBeInTheDocument();
  });

  it('renders one row per session with its scope, user and groups', () => {
    renderSection({ runtimes: [session()] });

    const row = screen.getByText('operator').closest('tr') as HTMLElement;
    expect(within(row).getByText('runtime')).toBeInTheDocument();
    expect(within(row).getByText('operators, guest')).toBeInTheDocument();
  });

  it('keys rows by client and scope so one client may hold both scopes', () => {
    renderSection({
      runtimes: [
        session({ scope: 'runtime' }),
        session({ scope: 'config' }),
        session({ clientId: 'c2', username: 'engineer', scope: 'config' }),
      ],
    });

    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getAllByText('config')).toHaveLength(2);
  });

  it('refreshes the list on demand', async () => {
    const { onRefresh } = renderSection({ runtimes: [session()] });

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(onRefresh).toHaveBeenCalled();
  });

  it('swaps the refresh action for a spinner while loading', () => {
    const { container } = renderSection({ loading: true });

    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(container.querySelector('.app-spinner')).not.toBeNull();
    expect(container.querySelector('button')).toBeDisabled();
  });

  it('shows a load error instead of the empty state', () => {
    renderSection({ error: 'Error: 503 backend unreachable' });

    expect(screen.getByText('Error: 503 backend unreachable')).toBeInTheDocument();
    expect(screen.queryByText('No active runtimes.')).toBeNull();
  });

  it('keeps the last known rows visible alongside a refresh error', () => {
    renderSection({ runtimes: [session()], error: 'Error: 503 backend unreachable' });

    expect(screen.getByText('Error: 503 backend unreachable')).toBeInTheDocument();
    expect(screen.getByText('operator')).toBeInTheDocument();
  });
});
