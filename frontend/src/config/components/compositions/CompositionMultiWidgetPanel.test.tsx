import { fireEvent, render, screen } from '@testing-library/react';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { WidgetConfig } from '@shared/types/config';
import CompositionMultiWidgetPanel from './CompositionMultiWidgetPanel';

function registerFake(type: string, schema: Record<string, SchemaField>): void {
  widgetRegistry[type] = {
    name: type,
    render: () => null,
    schema,
  } as unknown as (typeof widgetRegistry)[string];
}

const widget = (id: string, properties: Record<string, unknown> = {}): WidgetConfig => ({
  id,
  type: 'CompMulti',
  name: id,
  properties,
});

function setup(comps: WidgetConfig[]) {
  const onUpdate = vi.fn();
  const view = render(
    <CompositionMultiWidgetPanel comps={comps} componentProperties={{}} onUpdate={onUpdate} />,
  );
  return { ...view, onUpdate };
}

beforeEach(() => {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  registerFake('CompMulti', {
    label: { type: 'String', label: 'Label' },
  });
});

describe('CompositionMultiWidgetPanel', () => {
  it('writes one edit to every selected widget', () => {
    const { onUpdate } = setup([widget('a', { label: 'Go' }), widget('b', { label: 'Stop' })]);

    expect(screen.getByText('2 components')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Mixed');
    fireEvent.change(input, { target: { value: 'Both' } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith(['a', 'b'], { properties: { label: 'Both' } });
  });

  it('offers no variable binding picker — $var is forbidden while authoring', () => {
    setup([
      widget('a', { label: { $var: { path: 'ds:a' } } }),
      widget('b', { label: { $var: { path: 'ds:b' } } }),
    ]);

    expect(screen.queryByTitle('Change variable binding')).not.toBeInTheDocument();
  });

  it('renders plain sections, not the collapsible ones of the page editor', () => {
    const { container } = setup([widget('a'), widget('b')]);

    expect(container.querySelector('.cfg-section__title')).toBeInTheDocument();
    expect(container.querySelector('.cfg-section__header')).not.toBeInTheDocument();
  });
});
