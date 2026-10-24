import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHmiStore, type ToastEntry } from '@hmi/store/hmiStore';
import { THEME_TOKENS } from '@shared/utils/themeTokens';
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

  it('has a stylesheet rule for every themed position, shape and severity colour', async () => {
    // jsdom gives import.meta.url no file scheme; vitest runs from frontend/.
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/hmi/components/ToastStack/toast-stack.css', 'utf8');
    const tokens = THEME_TOKENS.filter((t) => t.section === 'toasts');

    // Position is matched by edge (^=) and side ($=); top and center are the unattributed default.
    expect(css).toContain("[data-hmi-toast-position^='bottom'] .hmi-toast-stack");
    expect(css).toContain("[data-hmi-toast-position$='left'] .hmi-toast-stack");
    expect(css).toContain("[data-hmi-toast-position$='right'] .hmi-toast-stack");
    expect(css).toContain("[data-hmi-toast-shape='pill'] .hmi-toast-stack .hmi-toast");
    const colours = tokens.filter((t) => t.inputType === 'color');
    expect(colours).toHaveLength(8);
    // Prettier may wrap a var() fallback, so compare without whitespace.
    for (const t of colours) expect(css.replace(/\s+/g, '')).toContain(`var(${t.cssVar}`);
  });

  it('keeps the themed shape and colours off the alarm cards that share the toast classes', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/hmi/components/ToastStack/toast-stack.css', 'utf8');
    const themed = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
      ([, selector, body]) =>
        selector.includes('data-hmi-toast-shape') ||
        /--hmi-toast-(themed|\w+-(bg|text))/.test(body),
    );

    expect(themed.length).toBe(12);
    for (const [, selector] of themed) expect(selector).toContain('.hmi-toast-stack .hmi-toast');
  });
});
