import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { HmiWidgetProps, ShellConfig, WidgetConfig } from '@shared/types/config';
import { useVariableStore } from '@hmi/store/variableStore';
import { useRecipeStore } from '@hmi/store/recipeStore';
import { useAlarmStore } from '@hmi/store/alarmStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useDeviceInfoStore } from '@hmi/store/deviceInfoStore';
import { useConfigStore } from '@shared/store/configStore';
import { useComponentStore } from '@shared/store/componentStore';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { componentPropertyToSchemaField } from '@shared/types/componentProperty';
import WidgetRenderer from './WidgetRenderer';
import { InputScopeContext } from '../context/InputScopeContext';
import { registerCustomWidget, widgetRegistry } from '../registry/widgetRegistry';
import { useEvalContext } from '../hooks/useEvalContext';
import { evaluatePropertyValue } from '../utils/propertySourceEval';
import { CountingProbe, GateProbe, renderCounts } from './__fixtures__/probeWidgets';

vi.mock('../registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry/widgetRegistry')>();
  const { CountingProbe, GateProbe, LabeledProbe, ThrowingWidget } =
    await import('./__fixtures__/probeWidgets');
  return {
    ...actual,
    widgetRegistry: {
      ...actual.widgetRegistry,
      // Fixtures keep the suite off the real catalog, whose leaves are
      // built-in widgets: lazy modules jsdom cannot fetch, and whose test shim
      // can't be imported at module scope without loading the real registry
      // and defeating this very mock (see setShell below).
      CountingProbe,
      GateProbe,
      LabeledProbe,
      ThrowingWidget,
    },
  };
});

// Shows its `value` evaluated through its own `useEvalContext()`, as a widget
// reads its properties, and its resolved layout width; counts its renders.
// Registered here, not in the mock: the eval context's imports reach the
// registry that mock stands in for.
function EvalProbe({ id = '', properties, layout }: HmiWidgetProps) {
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
  const value = evaluatePropertyValue(properties?.value, useEvalContext());
  return (
    <output data-testid={id} data-width={String(layout?.width)}>
      {String(value)}
    </output>
  );
}
widgetRegistry.EvalProbe = {
  name: 'Eval Probe',
  category: 'Test',
  component: EvalProbe,
  schema: {},
};

// Stand-ins under the real host types, whose manifest rows still decide how
// the renderer treats their children: a Container only renders them, an
// ImageContainer also reads each one's `visible` with its own eval context.
function ChildReaderProbe({ id = '', childConfigs }: HmiWidgetProps) {
  const visible = evaluatePropertyValue(childConfigs?.[0]?.properties?.visible, useEvalContext());
  return <output data-testid={id}>{String(visible)}</output>;
}
widgetRegistry.Container = CountingProbe;
widgetRegistry.ImageContainer = { ...GateProbe, component: ChildReaderProbe };

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

  it('marks each widget with its id in the runtime, outside the editor preview', () => {
    renderNode({ id: 'pump-start', type: 'GateProbe', name: 'Probe', properties: {} });

    const wrapper = document.querySelector('[data-widget-id="pump-start"]');
    expect(wrapper?.getAttribute('data-widget-type')).toBe('GateProbe');
    expect(wrapper?.querySelector('.hmi-gate-probe')).not.toBeNull();
  });

  // A parent re-renders its children whenever it re-renders itself — its own
  // `$var` ticked, or a Repeater rebuilt its copies for one changed element.
  it('re-renders only the widget whose own data changed, not its unchanged siblings', async () => {
    useVariableStore.setState({ values: { 'PLC:Row': 1, 'PLC:A': 1, 'PLC:B': 1 } });
    const probe = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
      id,
      type: 'CountingProbe',
      name: id,
      properties: { value: { $var: { path: `PLC:${id}` } } },
      children,
    });
    renderNode(probe('Row', [probe('A'), probe('B')]));
    const rendersAfter = async (values: Record<string, unknown>) => {
      renderCounts.clear();
      await act(async () => useVariableStore.getState().applyBatch(values));
      return Object.fromEntries(renderCounts);
    };

    expect(await rendersAfter({ 'PLC:Row': 2 })).toEqual({ Row: 1 });
    expect(await rendersAfter({ 'PLC:A': 2 })).toEqual({ A: 1 });
  });

  // The changed fields compare the loaded dataset with the parameters' live
  // values, which the `$recipe` source does not name.
  it('re-renders a widget reading whether recipe parameters changed when one is edited', async () => {
    useRecipeStore.getState().setSnapshot(
      {
        version: 1,
        datasetTypes: [
          {
            id: 'coffee',
            name: 'Coffee',
            parameters: [
              {
                id: 'dose',
                label: 'Dose',
                binding: { $var: { path: 'PLC:Dose' } },
                dataType: 'integer',
              },
            ],
            datasets: [
              {
                id: 'espresso',
                name: 'Espresso',
                description: '',
                values: { dose: 18 },
                updatedAt: '',
                updatedBy: '',
                loadedAt: '',
              },
            ],
          },
        ],
      },
      { coffee: { datasetId: 'espresso', loadedAt: '' } },
      null,
    );
    useVariableStore.setState({ values: { 'PLC:Row': 1, 'PLC:Dose': 18 } });
    renderNode({
      id: 'row',
      type: 'CountingProbe',
      name: 'Row',
      properties: { value: { $var: { path: 'PLC:Row' } } },
      children: [
        {
          id: 'unsaved',
          type: 'GateProbe',
          name: 'Unsaved',
          properties: { visible: { $recipe: { type: 'coffee', field: 'parametersChanged' } } },
        },
      ],
    });
    expect(document.querySelector('.hmi-gate-probe')).toBeNull();

    await act(async () => useVariableStore.getState().applyBatch({ 'PLC:Dose': 20 }));
    expect(document.querySelector('.hmi-gate-probe')).not.toBeNull();
  });

  // Each store a source reads through the eval context: a change to it reaches
  // the widget reading the source, through its own `useEvalContext()`, and
  // re-renders no other.
  describe('store-backed sources', () => {
    const UNACKED = { $alarmCount: { filter: 'unacked' } };
    const raiseAlarms = () =>
      useAlarmStore.getState().setAlarmState([], {
        total: 3,
        unacked: 3,
        error_count: 3,
        warning_count: 0,
        info_count: 0,
      });

    beforeEach(() => {
      useAlarmStore.setState({
        summary: { total: 0, unacked: 0, error_count: 0, warning_count: 0, info_count: 0 },
      });
      useComponentPropStore.setState({ props: {} });
      useRecipeStore.setState({ config: { version: 1, datasetTypes: [] }, loaded: {} });
      useHmiStore.setState({ openPageOverlays: [] });
      useDeviceInfoStore.setState({ info: null });
      useConfigStore
        .getState()
        .setValueMaps([{ id: 'm', type: 'Integer', cases: [{ when: 1, then: UNACKED }] }]);
      useVariableStore.setState({ values: { 'PLC:A': 1 } });
    });

    it.each([
      ['$alarmCount', UNACKED, raiseAlarms, '3'],
      [
        '$widgetProp',
        { $widgetProp: { componentId: 'grid', property: 'row' } },
        () => useComponentPropStore.getState().setComponentProp('grid', 'row', 7),
        '7',
      ],
      [
        '$recipe',
        { $recipe: { type: 'coffee', field: 'loaded' } },
        () =>
          useRecipeStore
            .getState()
            .setSnapshot(
              { version: 1, datasetTypes: [] },
              { coffee: { datasetId: 'espresso', loadedAt: '' } },
              null,
            ),
        'true',
      ],
      [
        '$overlay',
        { $overlay: { page: 'device', param: 'device' } },
        () =>
          useHmiStore.getState().openPageOverlay({
            pageId: 'device',
            componentProperties: { device: 3 },
            size: 'auto',
            placement: 'center',
          }),
        '3',
      ],
      [
        '$device',
        { $device: { field: 'hostname' } },
        () =>
          useDeviceInfoStore.setState({
            info: { hostname: 'hmi-1', ipAddress: null, macAddress: null },
          }),
        'hmi-1',
      ],
      [
        'a source nested in a condition',
        {
          $if: { condition: { $compare: { left: UNACKED, operator: '>', right: 0 } }, true: 'on' },
        },
        raiseAlarms,
        'on',
      ],
      ['a value map case', { $map: { id: 'm', value: 1 } }, raiseAlarms, '3'],
    ])('follows %s and re-renders no other widget', async (_, value, change, shown) => {
      render(
        <MemoryRouter>
          <WidgetRenderer
            node={{ id: 'reader', type: 'EvalProbe', name: 'R', properties: { value } }}
          />
          <WidgetRenderer
            node={{
              id: 'other',
              type: 'EvalProbe',
              name: 'O',
              properties: { value: { $var: { path: 'PLC:A' } } },
            }}
          />
        </MemoryRouter>,
      );
      renderCounts.clear();
      await act(async () => change());
      expect(screen.getByTestId('reader').textContent).toBe(shown);
      expect([...renderCounts.keys()]).toEqual(['reader']);
    });

    // A host's children evaluate under their own renderers: following their
    // stores re-rendered every container above an alarm count on each update.
    it('leaves a store a child reads to the child, not the container around it', async () => {
      renderNode({
        id: 'box',
        type: 'Container',
        name: 'Box',
        properties: {},
        children: [{ id: 'count', type: 'EvalProbe', name: 'C', properties: { value: UNACKED } }],
      });
      renderCounts.clear();
      await act(async () => raiseAlarms());
      expect(screen.getByTestId('count').textContent).toBe('3');
      expect([...renderCounts.keys()]).toEqual(['count']);
    });

    it("follows a store a child's property reads for a host that reads it", async () => {
      renderNode({
        id: 'image',
        type: 'ImageContainer',
        name: 'Image',
        properties: {},
        children: [
          {
            id: 'lamp',
            type: 'GateProbe',
            name: 'L',
            properties: { visible: { $compare: { left: UNACKED, operator: '>', right: 0 } } },
          },
        ],
      });
      expect(screen.getByTestId('image').textContent).toBe('false');
      await act(async () => raiseAlarms());
      expect(screen.getByTestId('image').textContent).toBe('true');
    });

    // The host reads the child's raw `$componentProp`, which resolves the input
    // only at run time: nothing in the child names the store.
    it('follows a store a read child property reaches through a component input', async () => {
      render(
        <MemoryRouter>
          <InputScopeContext.Provider
            value={{
              properties: { show: { $compare: { left: UNACKED, operator: '>', right: 0 } } },
            }}
          >
            <WidgetRenderer
              node={{
                id: 'image',
                type: 'ImageContainer',
                name: 'Image',
                properties: {},
                children: [
                  {
                    id: 'lamp',
                    type: 'GateProbe',
                    name: 'L',
                    properties: { visible: { $componentProp: 'show' } },
                  },
                ],
              }}
            />
          </InputScopeContext.Provider>
        </MemoryRouter>,
      );
      expect(screen.getByTestId('image').textContent).toBe('false');
      await act(async () => raiseAlarms());
      expect(screen.getByTestId('image').textContent).toBe('true');
    });

    it('follows a source an input passes into a component', async () => {
      render(
        <MemoryRouter>
          <InputScopeContext.Provider value={{ properties: { count: UNACKED } }}>
            <WidgetRenderer
              node={{
                id: 'inner',
                type: 'EvalProbe',
                name: 'I',
                properties: { value: { $componentProp: 'count' } },
              }}
            />
          </InputScopeContext.Provider>
        </MemoryRouter>,
      );
      await act(async () => raiseAlarms());
      expect(screen.getByTestId('inner').textContent).toBe('3');
    });

    // The SDK hands a project widget `resolveAlarmCount` and the rest, so its
    // code may read a store no property of it names.
    it('follows every store for a project widget', async () => {
      function ResolverProbe({ id = '' }: HmiWidgetProps) {
        const unacked = useEvalContext().resolveAlarmCount?.('unacked');
        return <output data-testid={id}>{String(unacked)}</output>;
      }
      registerCustomWidget({
        key: 'ResolverProbe',
        name: 'ResolverProbe',
        group: null,
        hasStyle: false,
      });
      widgetRegistry.ResolverProbe = {
        name: 'Resolver Probe',
        category: 'Test',
        component: ResolverProbe,
        schema: {},
      };
      render(
        <MemoryRouter>
          <WidgetRenderer
            node={{ id: 'custom', type: 'ResolverProbe', name: 'C', properties: {} }}
          />
        </MemoryRouter>,
      );
      await act(async () => raiseAlarms());
      expect(screen.getByTestId('custom').textContent).toBe('3');
    });

    it('follows a source an input passes into a layout field', async () => {
      render(
        <MemoryRouter>
          <InputScopeContext.Provider
            value={{
              properties: { w: { $widgetProp: { componentId: 'slider', property: 'value' } } },
            }}
          >
            <WidgetRenderer
              node={{
                id: 'sized',
                type: 'EvalProbe',
                name: 'S',
                properties: {},
                layout: { width: { $componentProp: 'w' } } as never,
              }}
            />
          </InputScopeContext.Provider>
        </MemoryRouter>,
      );
      await act(async () =>
        useComponentPropStore.getState().setComponentProp('slider', 'value', 120),
      );
      expect(screen.getByTestId('sized').dataset.width).toBe('120');
    });

    it('follows the leaf a layout field binds through a bound index into a struct array', async () => {
      // `PLC:Motors/fWidth` at the index `PLC:Sel` holds is the member's own
      // leaf: the layout must subscribe to that, as a property would.
      const struct = {
        kind: 'struct' as const,
        name: 'ST_Motor',
        array: false,
        fields: ['fWidth'],
      };
      const float = { type: { kind: 'scalar' as const, base: 'Float' as const, array: false } };
      useVariableStore.setState({
        varMeta: {
          'PLC:Motors': { type: { ...struct, array: true } },
          'PLC:Motors/Motors[1]': { type: struct, position: 0 },
          'PLC:Motors/Motors[1]/fWidth': float,
          'PLC:Motors/Motors[2]': { type: struct, position: 1 },
          'PLC:Motors/Motors[2]/fWidth': float,
          'PLC:Sel': float,
        },
        values: { 'PLC:Sel': 1, 'PLC:Motors/Motors[2]/fWidth': 150 },
      });
      render(
        <MemoryRouter>
          <WidgetRenderer
            node={{
              id: 'sized',
              type: 'EvalProbe',
              name: 'S',
              properties: {},
              layout: {
                width: {
                  $var: { path: 'PLC:Motors/fWidth', index: { $var: { path: 'PLC:Sel' } } },
                },
              } as never,
            }}
          />
        </MemoryRouter>,
      );
      expect(screen.getByTestId('sized').dataset.width).toBe('150');

      await act(async () =>
        useVariableStore.getState().applyBatch({ 'PLC:Motors/Motors[2]/fWidth': 200 }),
      );
      expect(screen.getByTestId('sized').dataset.width).toBe('200');
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

    it('marks a variable read through an expression, not just a whole-property binding', () => {
      // The KPI shape: the value is a template and the variable sits in a
      // wildcard. It is still the number on screen, so a dead datasource has
      // to mark it.
      useVariableStore.setState({
        values: { 'PLC:Tanks/T1Volume': 812 },
        varMeta: {
          'PLC:Tanks/T1Volume': { type: { kind: 'scalar', base: 'Float', array: false } },
        },
        metadataReceived: true,
        snapshotReceived: true,
        wsConnected: true,
        opcuaConnected: { PLC: false },
      });

      const { container } = renderNode({
        id: 'kpi',
        type: 'LabeledProbe',
        name: 'KPI',
        properties: {
          label: 'Throughput',
          value: {
            $stringExpr: {
              template: '{1}',
              wildcards: { 1: { $var: { path: 'PLC:Tanks/T1Volume' } } },
            },
          },
        },
      });

      expect(container.querySelector('.hmi-binding-overlay--disconnected')).not.toBeNull();
    });

    it('marks a widget bound through a component property', () => {
      // Inside a component definition the leaf carries `$componentProp`; only
      // the resolved properties hold the real `$var`.
      useVariableStore.setState({
        values: {},
        varMeta: {},
        metadataReceived: true,
        snapshotReceived: true,
        wsConnected: true,
        opcuaConnected: {},
      });

      const { container } = render(
        <MemoryRouter>
          <InputScopeContext.Provider
            value={{ properties: { source: { $var: { path: 'PLC:Missing' } } } }}
          >
            <WidgetRenderer
              node={{
                id: 'leaf',
                type: 'LabeledProbe',
                name: 'Leaf',
                properties: { label: 'Start', variable: { $componentProp: 'source' } },
              }}
            />
          </InputScopeContext.Provider>
        </MemoryRouter>,
      );

      expect(container.querySelector('.hmi-binding-overlay--disabled')).not.toBeNull();
    });

    it('types the $if result on screen against the field, and re-judges when it flips', async () => {
      const scalar = (base: 'Boolean' | 'String') => ({
        type: { kind: 'scalar' as const, base, array: false },
      });
      useVariableStore.setState({
        values: { 'PLC:Detail': true, 'PLC:Status': {}, 'PLC:Name': 'Pump 1' },
        varMeta: {
          'PLC:Detail': scalar('Boolean'),
          'PLC:Status': { type: { kind: 'struct', name: 'Status', array: false, fields: [] } },
          'PLC:Name': scalar('String'),
        },
        metadataReceived: true,
        snapshotReceived: true,
        wsConnected: true,
        opcuaConnected: {},
      });

      const { container } = renderNode({
        id: 'label',
        type: 'LabeledProbe',
        name: 'Label',
        properties: {
          label: 'Pump',
          value: {
            $if: {
              condition: { $var: { path: 'PLC:Detail' } },
              true: { $var: { path: 'PLC:Status' } },
              false: { $var: { path: 'PLC:Name' } },
            },
          },
        },
      });
      // A struct in a string slot is wrong only while it is the branch on screen.
      expect(container.querySelector('.hmi-binding-overlay--disabled')).not.toBeNull();

      await act(async () => {
        useVariableStore.setState((s) => ({ values: { ...s.values, 'PLC:Detail': false } }));
      });
      expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
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

    // The editor preview keeps its nodes while a definition is edited: only the
    // registry entry, rewritten from a component-store listener, changes.
    it('re-judges a component instance when its definition changes, its node unchanged', async () => {
      useVariableStore.setState({
        values: { 'PLC:Name': 'Pump 1' },
        varMeta: { 'PLC:Name': { type: { kind: 'scalar', base: 'String', array: false } } },
        metadataReceived: true,
        snapshotReceived: true,
        wsConnected: true,
        opcuaConnected: {},
      });
      const pump = (type: string): ComponentDefinition => ({
        id: 'pump',
        name: 'Pump',
        componentProperties: { label: { type, label: 'Label', mode: 'binding' } },
        children: [],
      });
      // What AppInner's listener does through `registerComponents`, against the
      // registry this suite mocks.
      const unsubscribe = useComponentStore.subscribe(({ components }) => {
        for (const c of components) {
          widgetRegistry[`$component:${c.id}`] = {
            ...GateProbe,
            schema: { label: componentPropertyToSchemaField(c.componentProperties.label) },
          };
        }
      });
      act(() => useComponentStore.setState({ components: [pump('integer')] }));
      const node: WidgetConfig = {
        id: 'pump-1',
        type: '$component:pump',
        name: 'Pump 1',
        properties: { label: { $var: { path: 'PLC:Name' } } },
      };

      try {
        const { container } = renderNode(node);
        expect(container.querySelector('.hmi-binding-overlay--disabled')).not.toBeNull();

        await act(async () => useComponentStore.setState({ components: [pump('string')] }));
        expect(container.querySelector('.hmi-binding-overlay')).toBeNull();
      } finally {
        unsubscribe();
        delete widgetRegistry['$component:pump'];
        useComponentStore.setState({ components: [] });
      }
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

    it('runs the onInteractionDenied global event on a locked press', async () => {
      const { useConfigStore } = await import('@shared/store/configStore');
      useConfigStore.setState({
        shell: { lockedFeedback: 'none' },
        globalEvents: {
          onInteractionDenied: [
            { type: 'showToast', message: 'Please log in', severity: 'info', discard: 'auto' },
          ],
        },
      });
      const { container } = renderNode(lockedButton);

      fireEvent.click(container.querySelector('.hmi-lock-overlay')!);

      expect(useHmiStore.getState().pendingToasts.map((t) => t.message)).toEqual(['Please log in']);
      useConfigStore.setState({ globalEvents: {} });
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

    // The overlay only stops the pointer; Tab, Enter and Space went straight
    // past it to a locked Start button until its contents were made inert.
    it('takes a locked widget out of keyboard reach and marks it disabled', () => {
      const { container } = renderNode(lockedButton);

      const content = container.querySelector('.hmi-lock-content')!;
      expect(content).toHaveAttribute('inert');
      expect(content).toContainElement(container.querySelector('button'));
      expect(container.querySelector('.hmi-lock-wrapper')).toHaveAttribute('aria-disabled', 'true');
    });

    it('leaves an unlocked widget focusable and unwrapped', () => {
      const { container } = renderNode({ ...lockedButton, properties: { label: 'Start' } });

      expect(container.querySelector('[inert]')).toBeNull();
      expect(container.querySelector('.hmi-lock-wrapper')).toBeNull();
      expect(screen.getByRole('button', { name: 'Start' })).not.toHaveAttribute('aria-disabled');
    });

    // The wrapper takes over the flex-child role from the widget inside it,
    // which still renders and still applies its own `width`/`height` from the
    // same `layout` — so the wrapper must carry only the flex-child fields
    // (flexGrow here) and never `width`/`height` too, or a percentage size
    // resolves against the wrong box and the widget overflows its own wrapper.
    it("does not double-apply width/height onto the lock wrapper around the widget's own", () => {
      const { container } = renderNode({
        ...lockedButton,
        layout: { width: '50%', height: '80px', grow: 1 },
      });

      const wrapper = container.querySelector('.hmi-lock-wrapper') as HTMLElement;
      expect(wrapper.style.width).toBe('');
      expect(wrapper.style.height).toBe('');
      expect(wrapper.style.flexGrow).toBe('1');
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
