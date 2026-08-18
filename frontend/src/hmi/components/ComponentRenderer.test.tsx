// Renders real stdlib widgets (Label); bind the SDK and resolve their modules.
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
  padding: '14px 22px',
  grow: 1,
  shrink: 1,
  basis: '0',
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
    const { container } = renderInstance({ grow: 0, shrink: 0, basis: '154px' });
    await waitFor(() => expect(container.querySelector('.hmi-container')).not.toBeNull());
    const root = container.querySelector('.hmi-container') as HTMLElement;

    expect(root.style.getPropertyValue('--self-basis')).toBe('154px');
    expect(root.style.getPropertyValue('--self-grow')).toBe('0');
    expect(root.style.getPropertyValue('--self-shrink')).toBe('0');
  });

  it("leaves the definition's own child-layout alone", () => {
    // direction/gap/padding describe the component's insides — an instance
    // must not be able to reach in and restyle them.
    const { container } = renderInstance({
      grow: 0,
      direction: 'row',
      gap: '99px',
      padding: '99px',
    } as LayoutConfig);
    const root = container.querySelector('.hmi-container') as HTMLElement;

    expect(root.style.getPropertyValue('--container-direction')).toBe('column');
    expect(root.style.getPropertyValue('--container-gap')).toBe('5px');
    expect(root.style.padding).toBe('14px 22px');
  });

  it('keeps the definition root untouched when the instance has no layout', () => {
    const { container } = renderInstance(undefined);
    const root = container.querySelector('.hmi-container') as HTMLElement;

    expect(root.style.getPropertyValue('--self-grow')).toBe('1');
    expect(root.style.getPropertyValue('--self-basis')).toBe('0');
  });

  it('does not introduce a wrapper element around the definition', () => {
    // A wrapper would re-parent the roots and flip which axis their flex
    // properties resolve against — a `basis: 0` root collapsing to no height.
    const { container } = renderInstance({ grow: 1 });
    expect(container.firstElementChild?.classList.contains('hmi-container')).toBe(true);
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
    // Label is a stdlib widget: its module is lazy, so the first render suspends.
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
