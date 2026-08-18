import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore, type AlertEntry } from '@hmi/store/hmiStore';
import { AlertModal } from './index';

function mkAlert(overrides: Partial<AlertEntry> = {}): AlertEntry {
  return {
    id: 'alert-1',
    title: 'Motor Fault',
    description: 'Motor 1 has exceeded its temperature limit.',
    cancelText: 'Cancel',
    okText: 'OK',
    dismissible: true,
    onCancel: [],
    onOk: [],
    ...overrides,
  };
}

function renderAlertModal() {
  return render(
    <MemoryRouter>
      <AlertModal scope="runtime:test" />
    </MemoryRouter>,
  );
}

describe('AlertModal', () => {
  beforeEach(() => {
    useHmiStore.setState({ pendingAlerts: [] });
  });

  it('renders nothing when there is no pending alert', () => {
    const { container } = renderAlertModal();
    expect(container.firstChild).toBeNull();
  });

  it('renders the first pending alert with title, description, and button labels', () => {
    useHmiStore.setState({ pendingAlerts: [mkAlert()] });
    renderAlertModal();

    expect(screen.getByText('Motor Fault')).toBeInTheDocument();
    expect(screen.getByText('Motor 1 has exceeded its temperature limit.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  });

  it('shows only the oldest pending alert when several are queued', () => {
    useHmiStore.setState({
      pendingAlerts: [mkAlert({ id: 'a', title: 'First' }), mkAlert({ id: 'b', title: 'Second' })],
    });
    renderAlertModal();

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
  });

  it('dismisses via the close button when dismissible, without running onCancel/onOk', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({ pendingAlerts: [mkAlert()] });
    renderAlertModal();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(useHmiStore.getState().pendingAlerts).toHaveLength(0);
  });

  it('dismisses via a backdrop click when dismissible', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({ pendingAlerts: [mkAlert()] });
    const { container } = renderAlertModal();

    await user.click(container.querySelector('.hmi-alert-backdrop') as HTMLElement);

    expect(useHmiStore.getState().pendingAlerts).toHaveLength(0);
  });

  it('hides the close button and ignores backdrop clicks when not dismissible', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({ pendingAlerts: [mkAlert({ dismissible: false })] });
    const { container } = renderAlertModal();

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    await user.click(container.querySelector('.hmi-alert-backdrop') as HTMLElement);

    expect(useHmiStore.getState().pendingAlerts).toHaveLength(1);
  });

  it('clicking the modal card does not bubble up to dismiss via the backdrop', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({ pendingAlerts: [mkAlert()] });
    renderAlertModal();

    await user.click(screen.getByText('Motor Fault'));

    expect(useHmiStore.getState().pendingAlerts).toHaveLength(1);
  });

  it('dismisses and advances to the next alert on Cancel', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({
      pendingAlerts: [mkAlert({ id: 'a', title: 'First' }), mkAlert({ id: 'b', title: 'Second' })],
    });
    renderAlertModal();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(useHmiStore.getState().pendingAlerts.map((a) => a.id)).toEqual(['b']);
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('dismisses on OK', async () => {
    const user = userEvent.setup();
    useHmiStore.setState({ pendingAlerts: [mkAlert()] });
    renderAlertModal();

    await user.click(screen.getByRole('button', { name: 'OK' }));

    expect(useHmiStore.getState().pendingAlerts).toHaveLength(0);
  });

  it('renders custom cancel/OK labels', () => {
    useHmiStore.setState({
      pendingAlerts: [mkAlert({ cancelText: 'Ignore', okText: 'Acknowledge' })],
    });
    renderAlertModal();

    expect(screen.getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });
});
