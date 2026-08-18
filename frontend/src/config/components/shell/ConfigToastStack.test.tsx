import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHmiStore, type ToastEntry } from '@hmi/store/hmiStore';
import { ConfigToastStack } from './ConfigToastStack';

beforeEach(() => {
  vi.useFakeTimers();
  useHmiStore.setState({ pendingToasts: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pushToast(overrides: Partial<ToastEntry> = {}) {
  useHmiStore.getState().showToast({
    id: 't1',
    message: 'Saved',
    severity: 'info',
    discard: 'auto',
    duration: 2500,
    ...overrides,
  });
}

describe('ConfigToastStack', () => {
  it('renders nothing when there are no pending toasts', () => {
    const { container } = render(<ConfigToastStack />);
    expect(container).toBeEmptyDOMElement();
  });

  it('auto-dismisses an "auto" toast from the store after its duration elapses', () => {
    pushToast({ duration: 2500 });
    render(<ConfigToastStack />);
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2499));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);

    act(() => void vi.advanceTimersByTime(1));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
  });

  it('never auto-dismisses a "manual" toast', () => {
    pushToast({ discard: 'manual', duration: 2500 });
    render(<ConfigToastStack />);

    act(() => void vi.advanceTimersByTime(100_000));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
  });

  it('clears the pending timer on unmount so it never fires after the component is gone', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    pushToast({ duration: 2500 });
    const { unmount } = render(<ConfigToastStack />);

    unmount();

    expect(clearSpy).toHaveBeenCalled();
    // Advancing time after unmount must not throw or dismiss anything via a
    // stale timer (there's nothing left mounted to observe it, but the store
    // write would blow up if the effect's cleanup hadn't run).
    act(() => void vi.advanceTimersByTime(10_000));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
  });

  it('restarts the timer independently when the toast id changes (dismiss then re-show)', () => {
    pushToast({ id: 't1', duration: 1000 });
    const { rerender } = render(<ConfigToastStack />);

    act(() => void vi.advanceTimersByTime(999));
    useHmiStore.getState().dismissToast('t1');
    pushToast({ id: 't2', duration: 1000 });
    rerender(<ConfigToastStack />);

    // The old timer (for t1) firing late must not affect t2's fresh toast.
    act(() => void vi.advanceTimersByTime(999));
    expect(useHmiStore.getState().pendingToasts.map((t) => t.id)).toEqual(['t2']);

    act(() => void vi.advanceTimersByTime(1));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
  });
});
