import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { useVariableStore } from '../store/variableStore';
import { useWebSocket } from './useWebSocket';

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

  send(): void {}

  /** Matches the browser: closing a pending handshake only marks it CLOSING —
   *  the close event lands later, whenever the abort completes. */
  close(): void {
    if (this.readyState !== FakeSocket.CLOSED) this.readyState = FakeSocket.CLOSING;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
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
});
