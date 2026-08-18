import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TelemetrySection, { type TelemetryStatus } from './index';

function status(overrides: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return {
    enabled: true,
    envOverride: null,
    installId: 'b'.repeat(32),
    ...overrides,
  };
}

function renderSection(overrides: Partial<TelemetryStatus> | null, handlers = {}) {
  const props = {
    status: overrides === null ? null : status(overrides),
    onLoad: vi.fn().mockResolvedValue(undefined),
    onApply: vi.fn().mockResolvedValue(undefined),
    ...handlers,
  };
  render(<TelemetrySection {...props} />);
  return props;
}

describe('TelemetrySection', () => {
  it('shows the installation ID and which way the setting stands', () => {
    renderSection({ enabled: true });
    expect(screen.getByText('b'.repeat(32))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveClass('cfg-seg-btn--active');
  });

  it('turns reporting off', async () => {
    const props = renderSection({ enabled: true });
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledWith(false));
  });

  it('goes read-only when the environment pins the setting', () => {
    renderSection({ enabled: false, envOverride: false });
    expect(screen.queryByRole('button', { name: 'No' })).not.toBeInTheDocument();
    expect(screen.getByText('NEXTHMI_TELEMETRY')).toBeInTheDocument();
  });

  it('surfaces a failed change instead of pretending it took', async () => {
    const props = renderSection(
      { enabled: true },
      { onApply: vi.fn().mockRejectedValue(new Error('pinned by the environment')) },
    );
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(screen.getByText(/pinned by the environment/)).toBeInTheDocument());
    expect(props.onLoad).toHaveBeenCalled();
  });
});
