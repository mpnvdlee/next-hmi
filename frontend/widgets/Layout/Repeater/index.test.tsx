import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { WidgetConfig } from '@shared/types/config';
import { PreviewContext } from '@shared/context/PreviewContext';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import WidgetRenderer from '@hmi/components/WidgetRenderer';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiJson: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: [{ name: 'North' }, { name: 'South' }],
  })),
}));

const SCALAR_ARRAY = { type: { kind: 'scalar', base: 'Float', array: true } };
const STRING_ARRAY = { type: { kind: 'scalar', base: 'String', array: true } };
const SCALAR = (base: string) => ({ type: { kind: 'scalar', base, array: false } });
const MOTORS = { type: { kind: 'struct', name: 'Motors', fields: ['Name', 'Speed'], array: true } };

function label(id: string, text: unknown): WidgetConfig {
  return { id, type: 'Label', name: id, properties: { text } };
}

function repeater(
  properties: Record<string, unknown>,
  children: WidgetConfig[],
  id = 'rep',
): WidgetConfig {
  return { id, type: 'Repeater', name: id, properties, children };
}

function renderNode(node: WidgetConfig, preview = false) {
  return render(
    <MemoryRouter initialEntries={['/pages/test']}>
      <PreviewContext.Provider value={preview}>
        <WidgetRenderer node={node} />
      </PreviewContext.Provider>
    </MemoryRouter>,
  );
}

async function texts(pattern: RegExp): Promise<string[]> {
  return (await screen.findAllByText(pattern)).map((el) => el.textContent ?? '');
}

describe('Repeater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useComponentPropStore.setState({ props: {} });
  });

  it('draws its children once per static element, each reading its own member', async () => {
    renderNode(
      repeater(
        {
          items: [
            { label: 'Alpha', value: 'a' },
            { label: 'Beta', value: 'b' },
          ],
        },
        [label('l', { $repeatItem: { field: 'value', member: 'label' } })],
      ),
    );

    expect(await texts(/^(Alpha|Beta)$/)).toEqual(['Alpha', 'Beta']);
  });

  it('binds each copy to its own element of a scalar array variable', async () => {
    useVariableStore.setState({
      values: { 'PLC:Setpoints': [1.5, 2.5, 3.5] },
      varMeta: { 'PLC:Setpoints': SCALAR_ARRAY } as never,
    });
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Setpoints' } } }, [
        label('l', { $repeatItem: { field: 'value' } }),
      ]),
    );

    expect(await texts(/^\d\.5$/)).toEqual(['1.5', '2.5', '3.5']);
  });

  it('reads a struct-array member from its own leaf, whatever the element folder is named', async () => {
    useVariableStore.setState({
      values: {
        'PLC:Motors': [{ Name: 'stale' }, { Name: 'stale' }],
        'PLC:Motors/Line[0]/Name': 'Pump',
        'PLC:Motors/Line[1]/Name': 'Fan',
      },
      varMeta: {
        'PLC:Motors': MOTORS,
        'PLC:Motors/Line[0]/Name': SCALAR('String'),
        'PLC:Motors/Line[1]/Name': SCALAR('String'),
      } as never,
    });
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Motors' } } }, [
        label('l', { $repeatItem: { field: 'value', member: 'Name' } }),
      ]),
    );

    expect(await texts(/^(Pump|Fan)$/)).toEqual(['Pump', 'Fan']);
  });

  it('exposes the element index, honouring start offset and max items', async () => {
    renderNode(
      repeater({ items: ['a', 'b', 'c', 'd', 'e'], startOffset: 1, maxItems: 2 }, [
        label('l', {
          $stringExpr: { template: '#{1}', wildcards: { 1: { $repeatItem: { field: 'index' } } } },
        }),
      ]),
    );

    expect(await texts(/^#\d$/)).toEqual(['#1', '#2']);
  });

  it('reads a parallel array at the copy index through $var repeatIndex', async () => {
    useVariableStore.setState({
      values: { 'PLC:Setpoints': [10, 20], 'PLC:Names': ['Left', 'Right'] },
      varMeta: { 'PLC:Setpoints': SCALAR_ARRAY, 'PLC:Names': STRING_ARRAY } as never,
    });
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Setpoints' } } }, [
        label('l', { $var: { path: 'PLC:Names', repeatIndex: true } }),
      ]),
    );

    expect(await texts(/^(Left|Right)$/)).toEqual(['Left', 'Right']);
  });

  it('shows the empty text when there is nothing to draw', async () => {
    renderNode(repeater({ items: [], emptyText: 'No motors' }, [label('l', 'row')]));

    expect(await screen.findByText('No motors')).toBeInTheDocument();
    expect(screen.queryByText('row')).not.toBeInTheDocument();
  });

  it('writes a struct member of its own element from a Repeat-item action target', async () => {
    useVariableStore.setState({
      values: {
        'PLC:Motors': [{ Name: 'A' }, { Name: 'B' }],
        'PLC:Motors/[0]/Name': 'A',
        'PLC:Motors/[1]/Name': 'B',
      },
      varMeta: {
        'PLC:Motors': MOTORS,
        'PLC:Motors/[0]/Name': SCALAR('String'),
        'PLC:Motors/[1]/Name': SCALAR('String'),
        'PLC:Motors/[0]/Speed': SCALAR('Float'),
        'PLC:Motors/[1]/Speed': SCALAR('Float'),
      } as never,
    });
    const user = userEvent.setup();
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Motors' } } }, [
        {
          id: 'b',
          type: 'Button',
          name: 'b',
          properties: {
            label: { $repeatItem: { field: 'value', member: 'Name' } },
            actions: {
              onPress: [
                {
                  type: 'writeDataVariable',
                  target: { $repeatItem: { member: 'Speed' } },
                  value: 50,
                },
              ],
            },
          },
        },
      ]),
    );

    await user.click(await screen.findByRole('button', { name: 'B' }));

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'write_field',
        datasource: 'PLC',
        path: 'Motors/[1]/Speed',
        value: 50,
      }),
    );
  });

  it('writes one slot of a scalar array, with the value taken from the element', async () => {
    useVariableStore.setState({
      values: { 'PLC:Setpoints': [1, 2] },
      varMeta: { 'PLC:Setpoints': SCALAR_ARRAY } as never,
    });
    const user = userEvent.setup();
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Setpoints' } } }, [
        {
          id: 'b',
          type: 'Button',
          name: 'b',
          properties: {
            label: { $repeatItem: { field: 'index' } },
            actions: {
              onPress: [
                {
                  type: 'writeDataVariable',
                  target: { $repeatItem: {} },
                  value: { $repeatItem: { field: 'index' } },
                },
              ],
            },
          },
        },
      ]),
    );

    await user.click(await screen.findByRole('button', { name: '1' }));

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ datasource: 'PLC', path: 'Setpoints[1]', value: 1 }),
    );
  });

  it('lets an input widget write back to its own element of the array', async () => {
    useVariableStore.setState({
      values: { 'PLC:Enables': [false, false] },
      varMeta: {
        'PLC:Enables': { type: { kind: 'scalar', base: 'Boolean', array: true } },
      } as never,
    });
    const user = userEvent.setup();
    renderNode(
      repeater({ items: { $var: { path: 'PLC:Enables' } } }, [
        { id: 's', type: 'Switch', name: 's', properties: { variable: { $repeatItem: {} } } },
      ]),
    );

    const switches = await screen.findAllByRole('switch');
    await user.click(switches[1]);

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ datasource: 'PLC', path: 'Enables[1]', value: true }),
    );
  });

  it('keeps a widget export per copy, so a sibling reads the one beside it', async () => {
    const user = userEvent.setup();
    renderNode(
      repeater({ items: ['a', 'b'] }, [
        { id: 'in', type: 'StringInput', name: 'in', properties: {} },
        label('out', {
          $stringExpr: {
            template: 'got:{1}',
            wildcards: { 1: { $widgetProp: { componentId: 'in', property: 'value' } } },
          },
        }),
      ]),
    );

    const inputs = await screen.findAllByRole('textbox');
    await user.type(inputs[1], 'second');

    expect(await texts(/^got:/)).toEqual(['got:', 'got:second']);
  });

  it('draws the elements of an API response once it lands', async () => {
    renderNode(
      repeater({ items: { $http: { url: 'http://plant.local/lines', method: 'GET' } } }, [
        label('l', { $repeatItem: { field: 'value', member: 'name' } }),
      ]),
    );

    expect(await texts(/^(North|South)$/)).toEqual(['North', 'South']);
  });

  it("reads an outer copy's export from inside a nested Repeater", async () => {
    const user = userEvent.setup();
    renderNode(
      repeater({ items: ['a', 'b'] }, [
        { id: 'in', type: 'StringInput', name: 'in', properties: {} },
        repeater(
          { items: ['x'] },
          [
            label('out', {
              $stringExpr: {
                template: 'inner:{1}',
                wildcards: { 1: { $widgetProp: { componentId: 'in', property: 'value' } } },
              },
            }),
          ],
          'inner',
        ),
      ]),
    );

    const inputs = await screen.findAllByRole('textbox');
    await user.type(inputs[1], 'two');

    expect(await texts(/^inner:/)).toEqual(['inner:', 'inner:two']);
  });

  it('dims every copy but the first on the editor canvas, all selecting the template', async () => {
    const { container } = renderNode(
      repeater({ items: ['x', 'y', 'z'] }, [label('tpl', { $repeatItem: { field: 'value' } })]),
      true,
    );
    await texts(/^[xyz]$/);

    const nodes = [...container.querySelectorAll('[data-widget-id="tpl"]')];
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.classList.contains('hmi-preview-node--ghost'))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it('still draws the template once on the editor canvas when there is no data', async () => {
    renderNode(repeater({ items: [] }, [label('tpl', 'template row')]), true);

    expect(await screen.findByText('template row')).toBeInTheDocument();
  });
});
