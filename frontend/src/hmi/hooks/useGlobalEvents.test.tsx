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

describe('onVariableChanged', () => {
  // "Open a popup when the bool goes high": fire on change, gate with an If.
  const alarm = { $var: { path: 'M:Alarm' } };
  beforeEach(() => {
    useConfigStore.setState({
      globalEvents: {
        onVariableChanged: [
          {
            variable: alarm,
            actions: [
              {
                type: 'if',
                condition: alarm,
                then: [{ type: 'showToast', message: 'high', severity: 'info', discard: 'auto' }],
              },
            ],
          },
        ],
      },
    });
  });

  it('fires on the first value and on every change, not on a repeat', () => {
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    act(() => useVariableStore.setState({ values: { 'M:Alarm': true } }));
    expect(toasts()).toEqual(['high']);

    act(() => useVariableStore.setState({ values: { 'M:Alarm': true, 'M:Other': 1 } }));
    act(() => useVariableStore.setState({ values: { 'M:Alarm': false } }));
    expect(toasts()).toEqual(['high']);

    // A reconnect that drops the value and restores it is no change.
    act(() => useVariableStore.setState({ values: {} }));
    act(() => useVariableStore.setState({ values: { 'M:Alarm': false } }));
    act(() => useVariableStore.setState({ values: { 'M:Alarm': true } }));
    expect(toasts()).toEqual(['high', 'high']);
  });
});

describe('onVariableChanged on an element of a struct array', () => {
  // `M:Motors` at 1 of an array counting from 1: the server ships element
  // `[2]` under its own key, not the whole array.
  const S = { kind: 'struct' as const, name: 'Motor', array: true, fields: ['Run'] };
  beforeEach(() => {
    useVariableStore.setState({
      varMeta: {
        'M:Motors': { type: S },
        'M:Motors/[2]': { type: { ...S, array: false }, position: 1 },
      },
    });
    useConfigStore.setState({
      globalEvents: {
        onVariableChanged: [
          {
            variable: { $var: { path: 'M:Motors', index: 1 } },
            actions: [{ type: 'showToast', message: 'moved', severity: 'info', discard: 'auto' }],
          },
        ],
      },
    });
  });
  afterEach(() => useVariableStore.setState({ varMeta: {} }));

  it('reads the element under its own key', () => {
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    act(() => useVariableStore.setState({ values: { 'M:Motors/[2]': { Run: false } } }));
    expect(toasts()).toEqual(['moved']);

    act(() => useVariableStore.setState({ values: { 'M:Motors/[2]': { Run: true } } }));
    expect(toasts()).toEqual(['moved', 'moved']);
  });
});

describe('onUserLoggedIn / onUserLoggedOut', () => {
  const toast = (message: string) => [
    { type: 'showToast' as const, message, severity: 'info' as const, discard: 'auto' as const },
  ];
  const identity = (username: string, signedIn: boolean) => ({
    username,
    groups: [username],
    groupLabels: {},
    signedIn,
  });
  const receive = (username: string, signedIn: boolean) =>
    act(() => useHmiStore.getState().setCurrentUser('runtime', identity(username, signedIn)));

  beforeEach(() => {
    useHmiStore.setState({ currentUsersByScope: {} });
    useConfigStore.setState({
      globalEvents: { onUserLoggedIn: toast('in'), onUserLoggedOut: toast('out') },
    });
  });

  it.each(['guest', 'line'])(
    'fires once for a sign-in and once for a sign-out with auto-login user %s',
    (autoLogin) => {
      renderHook(() => useGlobalEvents('runtime'), { wrapper });

      receive(autoLogin, false);
      expect(toasts()).toEqual([]);
      receive('ann', true);
      receive('ann', true); // a regroup or a reconnect resuming the same sign-in
      expect(toasts()).toEqual(['in']);
      receive(autoLogin, false);
      receive(autoLogin, false);
      expect(toasts()).toEqual(['in', 'out']);
    },
  );

  it('counts a sign-in resumed after a reload as a sign-in', () => {
    renderHook(() => useGlobalEvents('runtime'), { wrapper });
    receive('ann', true);
    expect(toasts()).toEqual(['in']);
  });
});
