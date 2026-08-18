import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@shared/store/projectStore';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useSaveErrorToast } from './useSaveErrorToast';

function Probe() {
  useSaveErrorToast();
  return null;
}

beforeEach(() => {
  useHmiStore.setState({ pendingToasts: [] });
  useProjectStore.setState({ saveError: null });
  useUsersDomainStore.setState({ saveError: null });
});

afterEach(cleanup);

describe('useSaveErrorToast', () => {
  it('raises no toast while saves are succeeding', () => {
    render(<Probe />);
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
  });

  it('reports the save failure reason in a manually-dismissed error toast', () => {
    render(<Probe />);

    act(() => useProjectStore.setState({ saveError: 'Alarms: Disk full' }));

    const [toast] = useHmiStore.getState().pendingToasts;
    expect(toast.severity).toBe('error');
    expect(toast.discard).toBe('manual');
    expect(toast.message).toContain('Alarms: Disk full');
  });

  it('clears the store flag so an identical second failure toasts again', () => {
    render(<Probe />);

    act(() => useProjectStore.setState({ saveError: 'Alarms: Disk full' }));
    expect(useProjectStore.getState().saveError).toBeNull();

    act(() => useProjectStore.setState({ saveError: 'Alarms: Disk full' }));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(2);
  });

  it('reports a failed security save separately', () => {
    render(<Probe />);

    act(() => useUsersDomainStore.setState({ saveError: 'Password policy rejected' }));

    const [toast] = useHmiStore.getState().pendingToasts;
    expect(toast.message).toContain('Security settings were not saved');
    expect(toast.message).toContain('Password policy rejected');
  });
});
