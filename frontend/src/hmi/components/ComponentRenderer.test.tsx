// Renders real built-in widgets (Label); bind the SDK and resolve their modules.
import '../../../widgets/testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import { useComponentStore } from '@shared/store/componentStore';
import { PreviewContext } from '@shared/context/PreviewContext';
import ComponentRenderer from './ComponentRenderer';

const ROOT_LAYOUT: LayoutConfig = {
  direction: 'column',
  gap: '5px',
  paddingTop: '14px',
  paddingRight: '22px',
  paddingBottom: '14px',
  paddingLeft: '22px',
  grow: 1,
  minWidth: '0',
};

function defineComponent(children: unknown[]) {
  useComponentStore.setState({
    components: [{ id: 'cmp', name: 'Card', children } as unknown as ComponentDefinition],
    draftComponents: {},
  });
}

function renderInstance(layout?: LayoutConfig, childConfigs?: WidgetConfig[]) {
  return render(
    <MemoryRouter>
      <ComponentRenderer
        _widgetId="cmp"
        properties={{}}
        layout={layout}
        childConfigs={childConfigs}
      />
    </MemoryRouter>,
  );
}

describe('ComponentRenderer instance sizing', () => {
  beforeEach(() => {
    defineComponent([
      {
        id: 'root',
        type: 'Container',
        name: 'Root',
        layout: ROOT_LAYOUT,
        properties: { showWhenEmpty: true },
      },
    ]);
  });

  it("applies the instance's sizing to the definition root", async () => {
    const { container } = renderInstance({ grow: 0, width: '154px', minWidth: '154px' });
    await waitFor(() => expect(container.querySelector('.hmi-container')).not.toBeNull());
    const root = container.querySelector('.hmi-container') as HTMLElement;

    expect(root.style.width).toBe('154px');
    expect(root.style.flexGrow).toBe('0');
    // The definition's own `minWidth: '0'` loses to the instance's, rather
    // than the two merging per key from whichever side set it last.
    expect(root.style.minWidth).toBe('154px');
  });

  it("leaves the definition's own child-layout alone", () => {
    // direction/gap/padding describe the component's insides — an instance
    // must not be able to reach in and restyle them.
    const { container } = renderInstance({
      grow: 0,
      direction: 'row',
      gap: '99px',
      paddingTop: '99px',
    } as LayoutConfig);
    const root = container.querySelector('.hmi-container') as HTMLElement;
    // Padding lives on `.hmi-container__content` (no title on this root), not
    // on `.hmi-container` itself — see Container/index.tsx.
    const content = container.querySelector('.hmi-container__content') as HTMLElement;

    expect(root.style.getPropertyValue('--container-direction')).toBe('column');
    expect(root.style.getPropertyValue('--container-gap')).toBe('5px');
    // Padding must stay off `.hmi-container` itself: that element also carries
    // Fill mode's flex-grow/flex-basis, and a border-box element's own padding
    // sets a floor under `flex-basis: 0` that skews a configured Fill weight.
    expect(root.style.paddingTop).toBe('');
    expect(root.style.paddingRight).toBe('');
    expect(root.style.paddingBottom).toBe('');
    expect(root.style.paddingLeft).toBe('');
    expect(content.style.paddingTop).toBe('14px');
    expect(content.style.paddingRight).toBe('22px');
    expect(content.style.paddingBottom).toBe('14px');
    expect(content.style.paddingLeft).toBe('22px');
  });

  it('keeps the definition root untouched when the instance has no layout', () => {
    const { container } = renderInstance(undefined);
    const root = container.querySelector('.hmi-container') as HTMLElement;

    // jsdom's CSSOM normalises a unitless zero length to '0px' on a real CSS
    // property, unlike a custom property, which round-trips whatever it is given.
    expect(root.style.minWidth).toBe('0px');
    expect(root.style.getPropertyValue('--container-gap')).toBe('5px');
    // The definition's own `grow` reaches the root too, but neither axis is set
    // to Fill and no raw length is sizing this node, so nothing renders by it —
    // see `isPreModeShape` in layoutUtils.
    expect(root.style.flexGrow).toBe('');
  });

  it('does not introduce a wrapper element around the definition', () => {
    // A box-drawing wrapper would re-parent the roots and flip which axis their
    // flex properties resolve against — a Fill root collapsing to no height.
    // Only the `display: contents` widget wrappers (instance, then root) sit
    // between, and the flow rules in hmi.css look through both.
    const { container } = renderInstance({ grow: 1 });
    const root = container.querySelector('.hmi-container') as HTMLElement;
    let el = root.parentElement;
    while (el && el !== container) {
      expect(el.classList.contains('hmi-preview-node')).toBe(true);
      el = el.parentElement;
    }
  });

  it('sizes only the first root when a definition has more than one', () => {
    defineComponent([
      {
        id: 'a',
        type: 'Container',
        name: 'A',
        layout: ROOT_LAYOUT,
        properties: { showWhenEmpty: true },
      },
      {
        id: 'b',
        type: 'Container',
        name: 'B',
        layout: ROOT_LAYOUT,
        properties: { showWhenEmpty: true },
      },
    ]);
    const { container } = renderInstance({ width: '120px' });

    // Folding onto both would render two 120px boxes for one 120px instance.
    const roots = container.querySelectorAll('.hmi-container');
    expect(roots).toHaveLength(2);
    expect((roots[0] as HTMLElement).style.width).toBe('120px');
    expect((roots[1] as HTMLElement).style.width).toBe('');
  });
});

describe('ComponentRenderer slots', () => {
  function slot(id: string, name: string) {
    return { id, type: 'ComponentSlot', name: id, properties: { slot: name } };
  }
  function label(id: string, text: string): WidgetConfig {
    return { id, type: 'Label', name: text, properties: { text } };
  }

  it('renders each slot child where its definition asks for it', async () => {
    defineComponent([slot('s-head', 'header'), slot('s-body', 'body')]);
    const { container } = renderInstance(undefined, [
      { ...label('w1', 'Body text'), slot: 'body' },
      { ...label('w2', 'Head text'), slot: 'header' },
    ]);
    // Label is a built-in widget: its module is lazy, so the first render suspends.
    await screen.findByText('Head text');

    // One top-level box per slot, in definition order — not authoring order.
    const rendered = [...container.children].map((el) => el.textContent);
    expect(rendered).toEqual(['Head text', 'Body text']);
  });

  it('sends untagged children to the first slot', () => {
    defineComponent([slot('s-head', 'header'), slot('s-body', 'body')]);
    const { container } = renderInstance(undefined, [label('w1', 'Untagged')]);

    expect(container.textContent).toBe('Untagged');
  });

  it('still renders a child whose slot the definition dropped', () => {
    defineComponent([slot('s-body', 'body')]);
    const { container } = renderInstance(undefined, [{ ...label('w1', 'Orphan'), slot: 'gone' }]);

    expect(container.textContent).toContain('Orphan');
  });

  it('renders nothing extra for a definition with no slots', () => {
    defineComponent([{ id: 'lbl', type: 'Label', name: 'x', properties: { text: 'Static' } }]);
    const { container } = renderInstance(undefined, [label('w1', 'Nowhere')]);

    expect(container.textContent).toBe('Static');
  });

  it('marks definition-drawn nodes in the preview and leaves slot content unmarked', () => {
    // Widget ids are per-tree slugs, so the editor cannot tell a definition's
    // `body` from a page's by looking it up — this marker is what separates
    // "click resolves outward to the instance" from "select this widget".
    defineComponent([slot('s-body', 'body')]);
    const { container } = render(
      <MemoryRouter>
        <PreviewContext.Provider value={true}>
          <ComponentRenderer
            _widgetId="cmp"
            properties={{}}
            childConfigs={[{ ...label('w1', 'Caller content'), slot: 'body' }]}
          />
        </PreviewContext.Provider>
      </MemoryRouter>,
    );

    expect(container.querySelector('[data-widget-id="s-body"]')).toHaveAttribute(
      'data-widget-source',
      'definition',
    );
    expect(container.querySelector('[data-widget-id="w1"]')).not.toHaveAttribute(
      'data-widget-source',
    );
  });
});

describe('ComponentRenderer property defaults', () => {
  function defineWithProps(componentProperties: Record<string, unknown>) {
    useComponentStore.setState({
      components: [
        {
          id: 'cmp',
          name: 'Card',
          componentProperties,
          children: [
            {
              id: 'title',
              type: 'Label',
              name: 'Title',
              properties: { text: { $componentProp: 'title' } },
            },
          ],
        } as unknown as ComponentDefinition,
      ],
      draftComponents: {},
    });
  }

  function renderWith(properties: Record<string, unknown>) {
    return render(
      <MemoryRouter>
        <ComponentRenderer _widgetId="cmp" properties={properties} />
      </MemoryRouter>,
    );
  }

  it('fills in the declared default when the instance leaves it unset', () => {
    defineWithProps({ title: { type: 'string', label: 'Title', defaultValue: 'Untitled' } });
    expect(renderWith({}).container.textContent).toBe('Untitled');
  });

  it("lets the instance's own value win", () => {
    defineWithProps({ title: { type: 'string', label: 'Title', defaultValue: 'Untitled' } });
    expect(renderWith({ title: 'Set by caller' }).container.textContent).toBe('Set by caller');
  });

  it('treats an explicit null as a set value, not as unset', () => {
    // Clearing a field on purpose must not snap back to the default.
    defineWithProps({ title: { type: 'string', label: 'Title', defaultValue: 'Untitled' } });
    expect(renderWith({ title: null }).container.textContent).toBe('');
  });

  it('resolves to nothing when no default is declared', () => {
    defineWithProps({ title: { type: 'string', label: 'Title' } });
    expect(renderWith({}).container.textContent).toBe('');
  });
});

describe('ComponentRenderer actions', () => {
  it('resolves a $componentProp nested in an action when the action fires', async () => {
    const { useHmiStore } = await import('@hmi/store/hmiStore');
    const { fireEvent } = await import('@testing-library/react');
    useHmiStore.setState({ pendingToasts: [], numpadRequest: null });
    const label = { $componentProp: 'label' };
    defineComponent([
      {
        id: 'edit',
        type: 'Button',
        name: 'Edit',
        properties: {
          label: 'Edit',
          actions: {
            onPress: [
              {
                type: 'showToast',
                message: { $stringExpr: { template: 'Editing {1}', wildcards: { '1': label } } },
                severity: 'info',
                discard: 'auto',
              },
              {
                type: 'editValue',
                target: { $componentProp: 'value' },
                title: { $stringExpr: { template: 'Set {1}', wildcards: { '1': label } } },
              },
            ],
          },
        },
      },
    ]);
    render(
      <MemoryRouter>
        <ComponentRenderer
          _widgetId="cmp"
          properties={{ label: 'Max pressure', value: { $var: { path: 'CP:Params/Max' } } }}
        />
      </MemoryRouter>,
    );

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Edit' }));

    expect(useHmiStore.getState().pendingToasts.map((t) => t.message)).toEqual([
      'Editing Max pressure',
    ]);
    expect(useHmiStore.getState().numpadRequest?.title).toBe('Set Max pressure');
  });
});

describe('ComponentRenderer nested inputs', () => {
  it('keeps a $componentProp nested in another source live, in properties and layout', async () => {
    const { act } = await import('@testing-library/react');
    const { useVariableStore } = await import('@hmi/store/variableStore');
    useVariableStore.setState({ values: { 'PLC:M1/Run': false } });
    const running = { $componentProp: 'device/Run' };
    defineComponent([
      {
        id: 'root',
        type: 'Container',
        name: 'Root',
        layout: { width: { $if: { condition: running, true: '200px', false: '100px' } } },
        properties: { showWhenEmpty: true },
        children: [
          {
            id: 'state',
            type: 'Label',
            name: 'State',
            properties: { text: { $if: { condition: running, true: 'on', false: 'off' } } },
          },
        ],
      },
    ]);
    const { container } = render(
      <MemoryRouter>
        <ComponentRenderer _widgetId="cmp" properties={{ device: { $var: { path: 'PLC:M1' } } }} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toBe('off'));
    const root = () => container.querySelector('.hmi-container') as HTMLElement;
    expect(root().style.width).toBe('100px');

    await act(async () => {
      useVariableStore.setState((s) => ({ values: { ...s.values, 'PLC:M1/Run': true } }));
    });

    expect(container.textContent).toBe('on');
    expect(root().style.width).toBe('200px');
  });
});

describe('ComponentRenderer Value and Binding inputs', () => {
  async function renderTile(properties: Record<string, unknown>) {
    const { act } = await import('@testing-library/react');
    const { useVariableStore } = await import('@hmi/store/variableStore');
    const { sendWsMessage } = await import('@hmi/hooks/useWebSocket');
    useComponentStore.setState({
      components: [
        {
          id: 'cmp',
          name: 'Tile',
          componentProperties: {
            name: { type: 'string', label: 'Name', mode: 'value' },
            state: { type: 'string', label: 'State', mode: 'binding' },
          },
          children: [
            { id: 'n', type: 'Label', name: 'N', properties: { text: { $componentProp: 'name' } } },
            {
              id: 's',
              type: 'Label',
              name: 'S',
              properties: { text: { $componentProp: 'state' } },
            },
          ],
        } as unknown as ComponentDefinition,
      ],
      draftComponents: {},
    });
    const view = render(
      <MemoryRouter>
        <ComponentRenderer _widgetId="cmp" properties={properties} />
      </MemoryRouter>,
    );
    const set = (values: Record<string, unknown>) =>
      act(async () => {
        useVariableStore.setState((s) => ({ values: { ...s.values, ...values } }));
      });
    const localKey = () =>
      Object.keys(useVariableStore.getState().values).find((k) => k.startsWith('$input:'));
    return { ...view, set, localKey, sendWsMessage, act, useVariableStore };
  }

  it('reads a Value once, keeps writes local, and follows a Binding live', async () => {
    const { useVariableStore } = await import('@hmi/store/variableStore');
    useVariableStore.setState({ values: { 'PLC:Name': 'Pump', 'PLC:State': 'off' } });
    const t = await renderTile({
      name: { $var: { path: 'PLC:Name' } },
      state: { $var: { path: 'PLC:State' } },
    });
    await waitFor(() => expect(t.container.textContent).toBe('Pumpoff'));

    await t.set({ 'PLC:Name': 'Fan', 'PLC:State': 'on' });
    expect(t.container.textContent).toBe('Pumpon');

    const [, path] = t.localKey()!.split(':');
    await t.act(async () => {
      t.sendWsMessage({ type: 'write_field', datasource: '$input', path, value: 'Mine' });
    });
    expect(t.container.textContent).toBe('Mineon');
    expect(useVariableStore.getState().values['PLC:Name']).toBe('Fan');

    t.unmount();
    expect(t.localKey()).toBeUndefined();
  });

  it('waits for a variable that has not arrived before reading a Value', async () => {
    const { useVariableStore } = await import('@hmi/store/variableStore');
    useVariableStore.setState({ values: {} });
    const t = await renderTile({ name: { $var: { path: 'PLC:Name' } }, state: 'x' });
    await waitFor(() => expect(t.container.textContent).toBe('x'));

    await t.set({ 'PLC:Name': 'Pump' });
    expect(t.container.textContent).toBe('Pumpx');
    await t.set({ 'PLC:Name': 'Fan' });
    expect(t.container.textContent).toBe('Pumpx');
  });
});
