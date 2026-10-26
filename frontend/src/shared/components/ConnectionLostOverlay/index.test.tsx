import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ConnectionLostOverlay from '.';
import { useVariableStore } from '@hmi/store/variableStore';

const setConnected = (v: boolean) => act(() => useVariableStore.getState().setWsConnected(v));

describe('ConnectionLostOverlay', () => {
  beforeEach(() => useVariableStore.setState({ wsConnected: false }));

  it('stays hidden on the first connect, shows on a drop and calls onReturn when back', () => {
    const onReturn = vi.fn();
    render(<ConnectionLostOverlay onReturn={onReturn} />);

    setConnected(true);
    expect(screen.queryByRole('alert')).toBeNull();

    setConnected(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost');

    setConnected(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
