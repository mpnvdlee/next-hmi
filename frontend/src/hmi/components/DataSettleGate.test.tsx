import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import DataSettleGate, { PageDataSettleGate } from './DataSettleGate';
import WidgetRenderer from './WidgetRenderer';

vi.mock('../registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry/widgetRegistry')>();
  const { LabeledProbe } = await import('./__fixtures__/probeWidgets');
  return {
    ...actual,
    widgetRegistry: {
      ...actual.widgetRegistry,
      // A real built-in would be a lazy module jsdom cannot fetch; the overlay
      // is what's under test, not the widget under it.
      LabeledProbe,
    },
  };
});

const NODE = {
  id: 'w1',
  type: 'LabeledProbe',
  name: 'Probe',
  properties: { label: 'Start', variable: { $var: { path: 'PLC:Speed' } } },
};

function renderGated(settleKey: string | undefined, done: boolean) {
  return render(
    <MemoryRouter>
      <DataSettleGate settleKey={settleKey} done={done}>
        <WidgetRenderer node={NODE} />
      </DataSettleGate>
    </MemoryRouter>,
  );
}

describe('DataSettleGate', () => {
  beforeEach(() => {
    // A variable that exists but has never delivered a value — the state a page
    // is in for as long as its OPC-UA read takes.
    useVariableStore.setState({
      values: {},
      varMeta: { 'PLC:Speed': { type: { kind: 'scalar', base: 'Float', array: false } } },
      metadataReceived: true,
      snapshotReceived: true,
      wsConnected: true,
      opcuaConnected: {},
    });
  });

  it('shows no mark while the data is still landing', () => {
    const { container } = renderGated('p1', false);
    expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
  });

  it('marks a still-empty binding amber once the backend acks the page', () => {
    const { container } = renderGated('p1', true);
    expect(container.querySelector('.hmi-binding-overlay')).toHaveClass(
      'hmi-binding-overlay--nodata',
    );
  });

  it('marks it anyway if the ack never comes', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderGated('p1', false);
      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend one page's grace on the next", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderGated('p1', false);
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();

      // Navigating re-opens the window: p2's own data has not been asked for
      // yet, so its widgets must not inherit p1's verdict.
      rerender(
        <MemoryRouter>
          <DataSettleGate settleKey="p2" done={false}>
            <WidgetRenderer node={NODE} />
          </DataSettleGate>
        </MemoryRouter>,
      );
      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a page a fresh grace when it is navigated back to', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderGated('p1', false);
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();

      const at = (key: string) =>
        rerender(
          <MemoryRouter>
            <DataSettleGate settleKey={key} done={false}>
              <WidgetRenderer node={NODE} />
            </DataSettleGate>
          </MemoryRouter>,
        );
      at('p2');
      at('p1');
      // This gate is long-lived — HmiView never remounts it between pages — so
      // a latch keyed on "already closed for p1" would mark p1 the instant it
      // came back, while its fresh set_context was still out.
      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens the window when the ack is withdrawn under the page on screen', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = renderGated('p1', true);
      expect(container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();

      // A reconnect clears contextReadyPageIds without changing the page: the
      // values are being re-read, so the marks have to come off and the grace
      // start again rather than staying on from the previous settle.
      rerender(
        <MemoryRouter>
          <DataSettleGate settleKey="p1" done={false}>
            <WidgetRenderer node={NODE} />
          </DataSettleGate>
        </MemoryRouter>,
      );
      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still marks a dead connection while the window is open', () => {
    // The window exists to wait for values, not to hide a backend that is
    // down — and a reconnect reopens it, so suppressing this here would clear
    // every overlay on screen the moment the backend went away.
    useVariableStore.setState({ wsConnected: false });
    const { container } = renderGated('p1', false);
    expect(container.querySelector('.hmi-binding-overlay--disconnected')).not.toBeNull();
  });

  it('still marks a variable no datasource knows while the window is open', () => {
    useVariableStore.setState({ varMeta: {} });
    const { container } = renderGated('p1', false);
    expect(container.querySelector('.hmi-binding-overlay--disabled')).not.toBeNull();
  });

  it('leaves a value that did arrive unmarked', () => {
    useVariableStore.setState({ values: { 'PLC:Speed': 12.5 } });
    const { container } = renderGated('p1', true);
    expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
  });
});

describe('PageDataSettleGate', () => {
  beforeEach(() => {
    // Same "exists, never delivered" state the suite above uses: the only
    // question here is whether the ack names this page.
    useVariableStore.setState({
      values: {},
      varMeta: { 'PLC:Speed': { type: { kind: 'scalar', base: 'Float', array: false } } },
      metadataReceived: true,
      snapshotReceived: true,
      wsConnected: true,
      opcuaConnected: {},
    });
  });

  function renderFor(pageId: string) {
    return render(
      <MemoryRouter>
        <PageDataSettleGate pageId={pageId}>
          <WidgetRenderer node={NODE} />
        </PageDataSettleGate>
      </MemoryRouter>,
    );
  }

  it('settles a page on the ack echoing its id, not on the grace timer', () => {
    useVariableStore.setState({ contextReadyPageIds: ['x1'] });
    expect(renderFor('x1').container.querySelector('.hmi-binding-overlay--nodata')).not.toBeNull();
  });

  it('does not let an ack for another page settle this one', () => {
    useVariableStore.setState({ contextReadyPageIds: ['x2'] });
    expect(renderFor('x1').container.querySelector('.hmi-binding-overlay')).toBeNull();
  });
});
