import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { ackAlarm, ackAllAlarms } from '../components/alarmUtils';
import { useHmiStore } from '../store/hmiStore';
import { useVariableStore } from '../store/variableStore';
import { identityRequest, loadSessionToken } from '../utils/runtimeSession';
import { setBackendRestartHandler, useWebSocket } from './useWebSocket';

/** A WebSocket that never touches the network and fires its events on demand. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  /** Matches the browser: closing a pending handshake only marks it CLOSING —
   *  the close event lands later, whenever the abort completes. */
  close(): void {
    if (this.readyState !== FakeSocket.CLOSED) this.readyState = FakeSocket.CLOSING;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  fireClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

function Probe() {
  useWebSocket();
  return null;
}

describe('useWebSocket', () => {
  let realWebSocket: typeof WebSocket;

  beforeEach(() => {
    realWebSocket = globalThis.WebSocket;
    FakeSocket.instances = [];
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    useVariableStore.setState({ wsConnected: false, opcuaConnected: {} });
  });

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
  });

  it("keeps the live view's login token when a stale scope of the tab is reset", () => {
    // A remounted HmiView leaves its old scope on the socket; the server may
    // sign that one out after the live scope logged in afresh.
    sessionStorage.clear();
    render(<Probe />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    identityRequest('runtime:old');
    identityRequest('runtime:live');
    const identity = { type: 'user_identity', groups: [], groupLabels: {} };
    act(() =>
      socket.receive({
        ...identity,
        scope: 'runtime:live',
        username: 'bob',
        sessionToken: 'bob-token',
      }),
    );
    act(() => socket.receive({ ...identity, scope: 'runtime:old', username: 'guest' }));
    expect(loadSessionToken()).toBe('bob-token');
    // The token is also what tells a sign-in from the auto-login user.
    expect(useHmiStore.getState().currentUsersByScope['runtime:live'].signedIn).toBe(true);
    act(() => socket.receive({ ...identity, scope: 'runtime:live', username: 'guest' }));
    expect(loadSessionToken()).toBeUndefined();
    expect(useHmiStore.getState().currentUsersByScope['runtime:live'].signedIn).toBe(false);
  });

  it('drops the socket a StrictMode remount discarded, and keeps the live one', () => {
    // StrictMode mounts, unmounts and remounts the effect, so the first socket
    // is aborted mid-handshake and a second one takes over. The abort's close
    // event can land after the second socket has opened — a slow boot (cold
    // cache) is exactly when it does — and the connection is live either way.
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(FakeSocket.instances).toHaveLength(2);
    const [discarded, live] = FakeSocket.instances;

    act(() => live.open());
    act(() => useVariableStore.setState({ opcuaConnected: { PLC: true } }));
    expect(useVariableStore.getState().wsConnected).toBe(true);

    act(() => discarded.fireClose());

    expect(useVariableStore.getState().wsConnected).toBe(true);
    expect(useVariableStore.getState().opcuaConnected).toEqual({ PLC: true });
  });

  it('still marks the connection down when the live socket closes', () => {
    render(<Probe />);
    const live = FakeSocket.instances[FakeSocket.instances.length - 1];

    act(() => live.open());
    act(() => useVariableStore.setState({ opcuaConnected: { PLC: true } }));

    act(() => live.fireClose());

    expect(useVariableStore.getState().wsConnected).toBe(false);
    expect(useVariableStore.getState().opcuaConnected).toEqual({});
  });

  it('calls the restart handler only when a reconnect reaches a different backend', () => {
    vi.useFakeTimers();
    const onRestart = vi.fn();
    setBackendRestartHandler(onRestart);
    try {
      render(<Probe />);
      const reconnect = (bootId: string) => {
        const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
        act(() => socket.open());
        act(() => socket.receive({ type: 'var_snapshot', values: {}, bootId }));
        act(() => socket.fireClose());
        act(() => {
          vi.advanceTimersByTime(20_000);
        });
      };

      reconnect('boot-a');
      reconnect('boot-a');
      expect(onRestart).not.toHaveBeenCalled();

      reconnect('boot-b');
      expect(onRestart).toHaveBeenCalledTimes(1);
    } finally {
      setBackendRestartHandler(null);
      vi.useRealTimers();
    }
  });

  it('reconnects after the live socket closes', () => {
    vi.useFakeTimers();
    try {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());
      const before = FakeSocket.instances.length;

      act(() => live.fireClose());
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(FakeSocket.instances.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off while sockets close before the backend sends anything', () => {
    // A project at its connection cap closes the socket the manager already
    // opened: `onopen` fires every time, and resetting on it retried every 500 ms.
    vi.useFakeTimers();
    try {
      render(<Probe />);
      const refuse = () => {
        const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
        act(() => socket.open());
        act(() => socket.fireClose());
      };
      const sockets = () => FakeSocket.instances.length;

      refuse();
      act(() => vi.advanceTimersByTime(500));
      refuse();
      act(() => vi.advanceTimersByTime(999));
      expect(sockets()).toBe(2);
      act(() => vi.advanceTimersByTime(1));
      expect(sockets()).toBe(3);

      const live = FakeSocket.instances[sockets() - 1];
      act(() => live.open());
      act(() => live.receive({ type: 'var_snapshot', values: {}, bootId: 'boot-a' }));
      act(() => live.fireClose());
      act(() => vi.advanceTimersByTime(500));
      expect(sockets()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an alarm ack on its correlated response or error', async () => {
    render(<Probe />);
    const live = FakeSocket.instances[FakeSocket.instances.length - 1];
    act(() => live.open());
    const lastRequestId = () =>
      (JSON.parse(live.sent[live.sent.length - 1]) as { requestId: string }).requestId;
    useHmiStore.setState({ pendingToasts: [] });

    const accepted = ackAlarm('inst-1');
    act(() => live.receive({ type: 'alarm_ack_response', requestId: lastRequestId() }));
    await expect(accepted).resolves.toBe(true);

    const refused = ackAllAlarms();
    act(() =>
      live.receive({ type: 'alarm_ack_error', requestId: lastRequestId(), reason: 'not_found' }),
    );
    await expect(refused).resolves.toBe(false);
    expect(useHmiStore.getState().pendingToasts[0].message).toMatch(/no longer active/);
  });
});
