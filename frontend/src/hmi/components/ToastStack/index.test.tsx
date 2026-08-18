import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHmiStore, type ToastEntry } from '@hmi/store/hmiStore';
import { HmiToastStack } from './index';

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
    message: 'Recipe applied',
    severity: 'info',
    discard: 'auto',
    duration: 4000,
    ...overrides,
  });
}

describe('HmiToastStack', () => {
  it('renders nothing when there are no pending toasts', () => {
    const { container } = render(<HmiToastStack />);
    expect(container).toBeEmptyDOMElement();
  });

  it('auto-dismisses an "auto" toast after its duration elapses', () => {
    pushToast({ duration: 4000 });
    render(<HmiToastStack />);
    expect(screen.getByText('Recipe applied')).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(3999));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);

    act(() => void vi.advanceTimersByTime(1));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
  });

  it('never auto-dismisses a "manual" toast', () => {
    pushToast({ discard: 'manual' });
    render(<HmiToastStack />);

    act(() => void vi.advanceTimersByTime(100_000));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
  });

  it('clears the pending timer on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    pushToast();
    const { unmount } = render(<HmiToastStack />);

    unmount();

    expect(clearSpy).toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
  });

  it('dismisses immediately on close-button click regardless of the pending timer', () => {
    pushToast();
    render(<HmiToastStack />);

    screen.getByRole('button', { name: 'Dismiss notification' }).click();

    expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
    // The now-orphaned timer firing later must not throw.
    act(() => void vi.advanceTimersByTime(10_000));
  });
});
