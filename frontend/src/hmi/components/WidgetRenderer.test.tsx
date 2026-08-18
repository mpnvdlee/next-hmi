import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { HmiWidgetProps, ShellConfig } from '@shared/types/config';
import { useVariableStore } from '@hmi/store/variableStore';
import WidgetRenderer from './WidgetRenderer';

vi.mock('../registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry/widgetRegistry')>();
  return {
    ...actual,
    widgetRegistry: {
      ...actual.widgetRegistry,
      // The visibility gate is what's under test, not any particular widget.
      // A fixture defined here keeps the suite off the real catalog, whose
      // leaves are stdlib widgets: lazy modules jsdom cannot fetch, and whose
      // test shim can't be imported at module scope without loading the real
      // registry and defeating this very mock (see setShell below).
      GateProbe: {
        name: 'Gate Probe',
        category: 'Test',
        component: () => <div className="hmi-gate-probe" />,
        schema: {},
      },
      // Same reasoning, for the overlay tests: they assert WidgetRenderer keeps
      // the widget interactive//visible underneath, and need something with an
      // accessible name to point at.
      LabeledProbe: {
        name: 'Labeled Probe',
        category: 'Test',
        component: ({ properties }: HmiWidgetProps) => (
          <button type="button">{String(properties?.label ?? '')}</button>
        ),
        schema: {},
      },
      ThrowingWidget: {
        name: 'Throwing Widget',
        category: 'Test',
        component: () => {
          throw new Error('boom');
        },
        schema: {},
      },
    },
  };
});

function renderNode(node: Parameters<typeof WidgetRenderer>[0]['node']) {
  return render(
    <MemoryRouter>
      <WidgetRenderer node={node} />
    </MemoryRouter>,
  );
}

describe('WidgetRenderer', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: {},
      varMeta: {},
      metadataReceived: false,
      snapshotReceived: false,
      wsConnected: false,
      opcuaConnected: {},
    });
  });

  describe('visibility gate', () => {
    it('renders content by default when visible is unset', () => {
      renderNode({ id: 'a', type: 'GateProbe', name: 'Probe', properties: {} });

      expect(document.querySelector('.hmi-gate-probe')).not.toBeNull();
    });

    it('hides content when the visible property is false', () => {
      renderNode({ id: 'a', type: 'GateProbe', name: 'Probe', properties: { visible: false } });

      expect(document.querySelector('.hmi-gate-probe')).toBeNull();
    });

    it('shows content again once visible flips back to true', () => {
      const { rerender } = render(
        <MemoryRouter>
          <WidgetRenderer
            node={{ id: 'a', type: 'GateProbe', name: 'Probe', properties: { visible: false } }}
          />
        </MemoryRouter>,
      );
      expect(document.querySelector('.hmi-gate-probe')).toBeNull();

      rerender(
        <MemoryRouter>
          <WidgetRenderer
            node={{ id: 'a', type: 'GateProbe', name: 'Probe', properties: { visible: true } }}
          />
        </MemoryRouter>,
      );
      expect(document.querySelector('.hmi-gate-probe')).not.toBeNull();
    });
  });

  describe('binding-unavailable overlay', () => {
    it('shows the disabled overlay when a bound variable is not published by any datasource', () => {
      useVariableStore.setState({
        values: {},
        varMeta: {},
        metadataReceived: true,
        snapshotReceived: true,
        wsConnected: true,
        opcuaConnected: {},
      });

      const { container } = renderNode({
        id: 'btn',
        type: 'LabeledProbe',
        name: 'Probe',
        properties: { label: 'Start', variable: { $var: { path: 'PLC:Missing/Struct' } } },
      });

      const overlay = container.querySelector('.hmi-binding-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay).toHaveClass('hmi-binding-overlay--disabled');
      expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    });

    it('shows the disconnected overlay while the OPC-UA connection is down', () => {
      useVariableStore.setState({
        values: {},
        varMeta: {},
        metadataReceived: true,
        snapshotReceived: false,
        wsConnected: false,
        opcuaConnected: {},
      });

      const { container } = renderNode({
        id: 'btn',
        type: 'LabeledProbe',
        name: 'Probe',
        properties: { label: 'Start', variable: { $var: { path: 'PLC:Missing/Struct' } } },
      });

      expect(container.querySelector('.hmi-binding-overlay--disconnected')).not.toBeNull();
    });

    it('renders no overlay when there is no bound variable', () => {
      const { container } = renderNode({
        id: 'btn',
        type: 'LabeledProbe',
        name: 'Probe',
        properties: { label: 'Start' },
      });

      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
    });
  });

  describe('locked-interaction feedback', () => {
    const lockedButton = {
      id: 'btn',
      type: 'LabeledProbe',
      name: 'Probe',
      properties: { label: 'Start', interactable: false },
    };

    // The config store is imported lazily: pulling it in at module scope loads
    // the real widget registry before vi.mock can swap in ThrowingWidget.
    async function setShell(shell: ShellConfig) {
      const { useConfigStore } = await import('@shared/store/configStore');
      useConfigStore.setState({ shell });
    }

    beforeEach(async () => {
      await setShell({});
      useHmiStore.setState({ pendingToasts: [] });
    });

    it('flashes a marker at the pointer by default', () => {
      const { container } = renderNode(lockedButton);

      fireEvent.click(container.querySelector('.hmi-lock-overlay')!);

      expect(container.querySelector('.hmi-lock-flash')).not.toBeNull();
      expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
    });

    it('raises a single toast per widget in toast mode', async () => {
      await setShell({ lockedFeedback: 'toast' });
      const { container } = renderNode(lockedButton);
      const overlay = container.querySelector('.hmi-lock-overlay')!;

      fireEvent.click(overlay);
      fireEvent.click(overlay);

      expect(container.querySelector('.hmi-lock-flash')).toBeNull();
      expect(useHmiStore.getState().pendingToasts).toHaveLength(1);
      expect(useHmiStore.getState().pendingToasts[0].message).toBe('Interaction not permitted');
    });

    it('stays silent in none mode but keeps blocking the press', async () => {
      await setShell({ lockedFeedback: 'none' });
      const { container } = renderNode(lockedButton);

      fireEvent.click(container.querySelector('.hmi-lock-overlay')!);

      expect(container.querySelector('.hmi-lock-flash')).toBeNull();
      expect(useHmiStore.getState().pendingToasts).toHaveLength(0);
      expect(container.querySelector('.hmi-lock-wrapper')).not.toBeNull();
      expect(container.querySelector('.hmi-lock-wrapper')!.getAttribute('title')).toBeNull();
    });
  });

  describe('render-error boundary', () => {
    it('catches a crashing child widget instead of taking down the tree', async () => {
      // The child throws on purpose. React logs the caught error to
      // console.error and, in dev, re-dispatches it as a window 'error' event
      // that jsdom's virtual console reports too — both print an alarming stack
      // trace on a green run. Suppress the console log and mark the re-dispatch
      // handled so jsdom stays quiet.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const swallow = (event: ErrorEvent) => event.preventDefault();
      window.addEventListener('error', swallow);

      try {
        renderNode({ id: 'bad', type: 'ThrowingWidget', name: 'Bad Widget' });

        await waitFor(
          () => {
            expect(screen.getByTitle('boom')).toBeInTheDocument();
          },
          { timeout: 2000 },
        );
        expect(screen.getByText('⚠ ThrowingWidget')).toBeInTheDocument();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        window.removeEventListener('error', swallow);
        errorSpy.mockRestore();
      }
    });
  });
});
