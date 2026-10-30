import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '../store/hmiStore';
import { useVariableStore } from '../store/variableStore';
import { NO_DATA_GRACE_MS } from '../components/DataSettleGate';
import { useGlobalEvents } from './useGlobalEvents';

vi.mock('./useWebSocket', () => ({ sendWsMessage: vi.fn() }));

// The testbench machines' first-start guard: seed once, unless the tag says done.
const seedOnce = [
  {
    type: 'if' as const,
    condition: { $not: { value: { $var: { path: 'M:Machine/Initialized' } } } },
    then: [
      {
        type: 'showToast' as const,
        message: 'seeded',
        severity: 'info' as const,
        discard: 'auto' as const,
      },
    ],
  },
];

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const toasts = () => useHmiStore.getState().pendingToasts.map((t) => t.message);

beforeEach(() => {
  vi.useFakeTimers();
  useHmiStore.setState({ pendingToasts: [] });
  useVariableStore.setState({ values: {}, contextReadyPageIds: [] });
  useConfigStore.setState({ loaded: true, globalEvents: { onHmiLoaded: seedOnce } });
});
afterEach(() => vi.useRealTimers());

describe('onHmiLoaded', () => {
  it('waits for the first context values, so the guard reads the real tag', () => {
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    expect(toasts()).toEqual([]);

    act(() => {
      useVariableStore.setState({
        values: { 'M:Machine/Initialized': true },
        contextReadyPageIds: ['home'],
      });
    });
    act(() => vi.advanceTimersByTime(NO_DATA_GRACE_MS));
    expect(toasts()).toEqual([]);
  });

  it('runs once the values say the machine is not set up yet', () => {
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    act(() => {
      useVariableStore.setState({
        values: { 'M:Machine/Initialized': false },
        contextReadyPageIds: ['home'],
      });
    });
    expect(toasts()).toEqual(['seeded']);
  });

  it('runs after the grace when no context_ready ever comes', () => {
    useConfigStore.setState({
      globalEvents: {
        onHmiLoaded: [{ type: 'showToast', message: 'seeded', severity: 'info', discard: 'auto' }],
      },
    });
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    act(() => vi.advanceTimersByTime(NO_DATA_GRACE_MS - 1));
    expect(toasts()).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(toasts()).toEqual(['seeded']);
  });
});
