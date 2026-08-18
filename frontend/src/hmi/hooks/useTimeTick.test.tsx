import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimeTick } from './useTimeTick';

function Probe({ active, onRender }: { active: boolean; onRender: () => void }) {
  useTimeTick(active);
  onRender();
  return null;
}

describe('useTimeTick', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-renders active subscribers each second', () => {
    const onRender = vi.fn();
    render(<Probe active onRender={onRender} />);
    expect(onRender).toHaveBeenCalledTimes(1);
    // Flush each tick in its own act() so React commits them separately.
    act(() => void vi.advanceTimersByTime(1000));
    expect(onRender).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(1000));
    expect(onRender).toHaveBeenCalledTimes(3);
  });

  it('never re-renders inactive subscribers on the tick', () => {
    const onRender = vi.fn();
    render(<Probe active={false} onRender={onRender} />);
    expect(onRender).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5000));
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it('stops the shared interval when the last subscriber unmounts', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(<Probe active onRender={() => {}} />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
