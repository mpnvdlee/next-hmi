import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { ackAlarm, ackAllAlarms } from '../components/alarmUtils';
import { useHmiStore } from '../store/hmiStore';
import { useVariableStore } from '../store/variableStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { identityRequest, loadSessionToken } from '../utils/runtimeSession';
import {
  clearContextProducer,
  setBackendRestartHandler,
  setContextProducer,
  useWebSocket,
} from './useWebSocket';

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

  it("switches to a user's language when that user arrives, not on a refresh", () => {
    sessionStorage.clear();
    render(<Probe />);
    const socket = FakeSocket.instances[0];
    act(() => socket.open());
    identityRequest('runtime:lang');
    useTranslationStore.getState().setActiveLanguage('en');
    const identity = { type: 'user_identity', scope: 'runtime:lang', groups: [], groupLabels: {} };
    const accounts = [
      {
        username: 'ann',
        groups: ['admin'],
        language: 'de',
        locked: { delete: false, password: false, groups: false },
      },
    ];
    act(() => socket.receive({ ...identity, username: 'ann', language: 'de', accounts }));
    expect(useTranslationStore.getState().activeLanguage).toBe('de');
    expect(useHmiStore.getState().currentUsersByScope['runtime:lang'].accounts).toEqual(accounts);
    // A language picked during the session survives the same user's refresh.
    useTranslationStore.getState().setActiveLanguage('en');
    act(() => socket.receive({ ...identity, username: 'ann', language: 'de' }));
    expect(useTranslationStore.getState().activeLanguage).toBe('en');
    // No accounts on the wire: no longer a user admin.
    expect(useHmiStore.getState().currentUsersByScope['runtime:lang'].accounts).toBeUndefined();
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

  describe('set_context', () => {
    const sentContexts = (socket: FakeSocket) =>
      socket.sent
        .map((frame) => JSON.parse(frame) as { type: string; contextId?: number })
        .filter((msg) => msg.type === 'set_context');
    // The frames without their numbers, which only tell their acks apart.
    const contexts = (socket: FakeSocket) =>
      sentContexts(socket).map(({ contextId: _contextId, ...msg }) => msg);
    const lastContextId = (socket: FakeSocket) => {
      const sent = sentContexts(socket);
      return sent[sent.length - 1]?.contextId;
    };

    afterEach(() => {
      clearContextProducer('page');
      clearContextProducer('table');
    });

    it('merges the producers and sends each distinct context once', () => {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());

      setContextProducer('page', { currentPageIds: ['home'], priorityKeys: ['PLC:A'] });
      setContextProducer('page', { currentPageIds: ['home'], priorityKeys: ['PLC:A'] });
      // A variable table settling on the same rows again.
      setContextProducer('table', { priorityKeys: ['PLC:Motors'] });
      setContextProducer('table', { priorityKeys: ['PLC:Motors'] });
      setContextProducer('table', { priorityKeys: ['PLC:Pumps'] });

      expect(contexts(live)).toEqual([
        { type: 'set_context', currentPageIds: ['home'], priorityKeys: ['PLC:A'] },
        { type: 'set_context', currentPageIds: ['home'], priorityKeys: ['PLC:A', 'PLC:Motors'] },
        { type: 'set_context', currentPageIds: ['home'], priorityKeys: ['PLC:A', 'PLC:Pumps'] },
      ]);
    });

    it('sends the context again after a datasource or page edit, which it may now resolve differently', () => {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());
      setContextProducer('table', { priorityKeys: ['PLC:Speed'] });
      const changed = (artifact_type: string) =>
        live.receive({
          type: 'config_changed',
          artifact_type,
          artifact_ids: ['PLC'],
          source: 'rest',
          summary: '',
        });

      changed('variables');
      changed('datasource');
      changed('page');
      changed('translations');

      const table = { type: 'set_context', currentPageIds: [], priorityKeys: ['PLC:Speed'] };
      expect(contexts(live)).toEqual([table, table, table, table]);
      // Numbered apart all the same, so each one's ack is told from the others'.
      expect(new Set(sentContexts(live).map((msg) => msg.contextId)).size).toBe(4);
    });

    it("forgets a page's ack once the context leaves it, so a return waits for its own", async () => {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());
      const ready = () => useVariableStore.getState().contextReadyPageIds;
      const ack = async (pageIds: string[], contextId = lastContextId(live)) => {
        live.receive({ type: 'context_ready', currentPageIds: pageIds, contextId });
        await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      };

      setContextProducer('page', { currentPageIds: ['A'] });
      const firstVisit = lastContextId(live);
      await ack(['A']);
      expect(ready()).toEqual(['A']);
      // An overlay opening keeps the page under it settled.
      act(() => setContextProducer('page', { currentPageIds: ['A', 'O'] }));
      expect(ready()).toEqual(['A']);

      act(() => setContextProducer('page', { currentPageIds: ['B'] }));
      const onB = lastContextId(live);
      expect(ready()).toEqual([]);
      // Back on A before B's slow read answered: A's old ack must not settle it.
      act(() => setContextProducer('page', { currentPageIds: ['A'] }));
      expect(ready()).toEqual([]);
      await ack(['B'], onB); // superseded, dropped
      expect(ready()).toEqual([]);
      // The first visit's ack names the very same page, and is just as stale.
      await ack(['A'], firstVisit);
      expect(ready()).toEqual([]);
      await ack(['A']);
      expect(ready()).toEqual(['A']);

      // An ack received but not yet flushed when the context moves on.
      act(() => setContextProducer('page', { currentPageIds: ['B'] }));
      live.receive({
        type: 'context_ready',
        currentPageIds: ['B'],
        contextId: lastContextId(live),
      });
      act(() => setContextProducer('page', { currentPageIds: ['A'] }));
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(ready()).toEqual([]);
    });

    it('sends the context again on a reconnect, and only once', () => {
      vi.useFakeTimers();
      try {
        render(<Probe />);
        const first = FakeSocket.instances[FakeSocket.instances.length - 1];
        act(() => first.open());
        setContextProducer('page', { currentPageIds: ['home'] });
        act(() => first.fireClose());
        act(() => {
          vi.advanceTimersByTime(600);
        });
        const second = FakeSocket.instances[FakeSocket.instances.length - 1];

        act(() => second.open());
        // The page re-registers its unchanged context once it sees the socket back.
        setContextProducer('page', { currentPageIds: ['home'] });

        const home = { type: 'set_context', currentPageIds: ['home'], priorityKeys: [] };
        expect(contexts(first)).toEqual([home]);
        expect(contexts(second)).toEqual([home]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('values queued for the next frame', () => {
    const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const values = () => useVariableStore.getState().values;

    it('does not bring back a variable removed while its update waited', async () => {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());

      live.receive({ type: 'var_update', values: { 'PLC:A': 1, 'PLC:B': 2 } });
      live.receive({ type: 'var_removed', ids: ['PLC:A'] });
      await nextFrame();

      expect(values()).not.toHaveProperty('PLC:A');
      expect(values()).toHaveProperty('PLC:B', 2);
    });

    it('holds values queued before a metadata frame to its prune', async () => {
      render(<Probe />);
      const live = FakeSocket.instances[FakeSocket.instances.length - 1];
      act(() => live.open());
      const meta = (key: string) =>
        live.receive({ type: 'var_metadata', meta: { [key]: { type: { kind: 'scalar' } } } });

      meta('PLC:A');
      live.receive({ type: 'var_update', values: { 'PLC:A': 1 } });
      meta('PLC:B');
      await nextFrame();
      // The page just left keeps its value, for a return to it.
      expect(values()).toHaveProperty('PLC:A', 1);

      live.receive({ type: 'var_update', values: { 'PLC:A': 2 } });
      // Two more frames before the next animation frame: A is no longer one
      // of the last three, so its value goes, queued or not.
      meta('PLC:C');
      meta('PLC:D');
      await nextFrame();
      expect(values()).not.toHaveProperty('PLC:A');
    });

    describe('a struct-array element', () => {
      const S = { kind: 'struct', name: 'Motor', array: true, fields: ['fSpeed', 'stState'] };
      // What the server describes for a page binding `PLC:Motors` whole, or
      // one of its leaves: the element and the leaves below it.
      const META = {
        'PLC:Motors': { type: S },
        'PLC:Motors/[1]': { type: { ...S, array: false }, position: 0 },
        'PLC:Motors/[1]/fSpeed': { type: { kind: 'scalar', base: 'Float', array: false } },
        'PLC:Motors/[1]/stState': { type: { kind: 'struct', name: 'State', array: false } },
        'PLC:Motors/[1]/stState/bOn': { type: { kind: 'scalar', base: 'Boolean', array: false } },
      };
      const ELEMENT = 'PLC:Motors/[1]';
      const LEAF = 'PLC:Motors/[1]/fSpeed';
      const element = (fSpeed: number) => ({ fSpeed, stState: { bOn: true } });

      function connect() {
        render(<Probe />);
        const live = FakeSocket.instances[FakeSocket.instances.length - 1];
        act(() => live.open());
        const update = (values: Record<string, unknown>) =>
          live.receive({ type: 'var_update', values });
        const page = () => live.receive({ type: 'var_metadata', meta: META });
        return { update, page };
      }

      it('fills in the members below it as it arrives', async () => {
        const { update, page } = connect();
        page();
        update({ [ELEMENT]: element(1) });
        await nextFrame();
        expect(values()).toMatchObject({
          [LEAF]: 1,
          'PLC:Motors/[1]/stState': { bOn: true },
          'PLC:Motors/[1]/stState/bOn': true,
        });
        // In one frame the member the server ships itself wins: it is never the older.
        update({ [ELEMENT]: element(2), [LEAF]: 3 });
        await nextFrame();
        expect(values()[LEAF]).toBe(3);
      });

      it('reads the live value through a dialog binding the leaf and back', async () => {
        const { update, page } = connect();
        // The overview's Repeater: the server ships the element.
        page();
        update({ [ELEMENT]: element(1) });
        await nextFrame();
        expect(values()[LEAF]).toBe(1);

        // A dialog binding the leaf opens: both are shipped, the last one wins.
        update({ [LEAF]: 2 });
        update({ [ELEMENT]: element(2) });
        update({ [LEAF]: 3 });
        await nextFrame();
        expect(values()[LEAF]).toBe(3);

        // It closes: the leaf is no longer shipped, the element is.
        update({ [ELEMENT]: element(4) });
        await nextFrame();
        expect(values()[LEAF]).toBe(4);

        // A page binding only the leaf: the element it still holds is frozen.
        page();
        update({ [LEAF]: 5 });
        await nextFrame();
        update({ [LEAF]: 6 });
        await nextFrame();
        expect(values()[LEAF]).toBe(6);
        expect(values()[ELEMENT]).toEqual(element(4));

        // Back to the overview: the element is shipped again, current.
        page();
        update({ [ELEMENT]: element(7) });
        await nextFrame();
        expect(values()[LEAF]).toBe(7);
      });
    });
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
