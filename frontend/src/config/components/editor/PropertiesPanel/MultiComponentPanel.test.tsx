import { fireEvent, render, screen } from '@testing-library/react';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import { useConfigStore } from '@shared/store/configStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import PropertiesPanel from './index';

function registerFake(type: string, schema: Record<string, SchemaField>): void {
  widgetRegistry[type] = {
    name: type,
    render: () => null,
    schema,
  } as unknown as (typeof widgetRegistry)[string];
}

const widget = (
  id: string,
  type: string,
  properties: Record<string, unknown> = {},
): WidgetConfig => ({
  id,
  type,
  name: id,
  properties,
});

function setup(widgets: WidgetConfig[], selectedIds: string[]) {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useProjectStore.setState({ past: [], future: [] });
  useConfigStore.setState({
    loaded: true,
    pages: [{ id: 'page-1', type: 'page', title: 'One', sections: { content: widgets } }],
    loadedPageIds: new Set(['page-1']),
    header: [],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    shell: {},
    globalEvents: {},
    dirtyPageIds: new Set(),
  });
  useEditorDomainStore.setState({
    selectedId: selectedIds[selectedIds.length - 1] ?? null,
    selectedIds,
    selectionAnchorId: null,
    selectedRegion: null,
    selectedParam: null,
  });
  return render(<PropertiesPanel />);
}

const widgetOf = (id: string): WidgetConfig | undefined => {
  const page = useConfigStore.getState().pages[0];
  return (page.type === 'page' ? page.sections.content : []).find((w) => w.id === id);
};

const propsOf = (id: string): Record<string, unknown> => widgetOf(id)?.properties ?? {};
const layoutOf = (id: string): Record<string, unknown> =>
  (widgetOf(id)?.layout ?? {}) as Record<string, unknown>;

/** A layout value bound to a variable — sourced layout is a runtime shape the
 *  `LayoutConfig` string types don't spell out. `width` is a 'self' field, so it
 *  is offered for leaf widgets too. */
const varWidth = (path: string) => ({ width: { $var: { path } } }) as unknown as LayoutConfig;

beforeEach(() => {
  registerFake('MultiA', {
    label: { type: 'String', label: 'Label' },
    count: { type: 'Integer', label: 'Count' },
    hidden: {
      type: 'String',
      label: 'Only when counted',
      visibleWhen: { property: 'count', equals: 1 },
    },
  });
  registerFake('MultiB', {
    label: { type: 'String', label: 'Caption' },
    other: { type: 'String', label: 'Other' },
  });
  registerFake('MultiStruct', {
    alarms: { type: 'Alarms[]', label: 'Alarms' },
  });
});

describe('PropertiesPanel multi-selection', () => {
  it('shows every row when the widgets share a type', () => {
    setup([widget('a', 'MultiA'), widget('b', 'MultiA')], ['a', 'b']);

    expect(screen.getByText('2 components')).toBeInTheDocument();
    expect(screen.getByText('Label')).toBeInTheDocument();
    expect(screen.getByText('Count')).toBeInTheDocument();
  });

  it('shows only the shared rows when the types differ', () => {
    setup([widget('a', 'MultiA'), widget('b', 'MultiB')], ['a', 'b']);

    expect(screen.getByText('Label')).toBeInTheDocument();
    expect(screen.queryByText('Count')).not.toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('shows a shared value rather than a mixed marker', () => {
    setup(
      [widget('a', 'MultiA', { label: 'Go' }), widget('b', 'MultiA', { label: 'Go' })],
      ['a', 'b'],
    );

    expect(screen.getByDisplayValue('Go')).toBeInTheDocument();
  });

  it('marks a property the widgets disagree on as Mixed', () => {
    setup(
      [widget('a', 'MultiA', { label: 'Go' }), widget('b', 'MultiA', { label: 'Stop' })],
      ['a', 'b'],
    );

    const input = screen.getByPlaceholderText('Mixed');
    expect(input).toHaveValue('');
  });

  it('offers no revert affordance on a mixed row', () => {
    setup(
      [widget('a', 'MultiA', { label: 'Go' }), widget('b', 'MultiA', { label: 'Stop' })],
      ['a', 'b'],
    );

    expect(screen.queryByTitle(/^Revert to/)).not.toBeInTheDocument();
  });

  it('writes one edit to every selected widget', () => {
    setup(
      [widget('a', 'MultiA', { label: 'Go' }), widget('b', 'MultiA', { label: 'Stop' })],
      ['a', 'b'],
    );

    const input = screen.getByPlaceholderText('Mixed');
    fireEvent.change(input, { target: { value: 'Both' } });
    fireEvent.blur(input);

    expect(propsOf('a').label).toBe('Both');
    expect(propsOf('b').label).toBe('Both');
  });

  it('records one undo entry for the whole fan-out', () => {
    setup(
      [widget('a', 'MultiA', { label: 'Go' }), widget('b', 'MultiA', { label: 'Stop' })],
      ['a', 'b'],
    );
    // The snapshot is throttled on Date.now, which an earlier test in this file
    // has already consumed — move past the window so this write is not skipped.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

    const input = screen.getByPlaceholderText('Mixed');
    fireEvent.change(input, { target: { value: 'Both' } });
    fireEvent.blur(input);

    expect(useProjectStore.getState().past).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('hides a row that is invisible for any selected widget', () => {
    setup([widget('a', 'MultiA', { count: 1 }), widget('b', 'MultiA', { count: 2 })], ['a', 'b']);

    expect(screen.queryByText('Only when counted')).not.toBeInTheDocument();
  });

  it('shows a conditional row once every selected widget would show it', () => {
    setup([widget('a', 'MultiA', { count: 1 }), widget('b', 'MultiA', { count: 1 })], ['a', 'b']);

    expect(screen.getByText('Only when counted')).toBeInTheDocument();
  });

  it('always offers the Layout section', () => {
    setup([widget('a', 'MultiA'), widget('b', 'MultiB')], ['a', 'b']);

    expect(screen.getByText('Layout')).toBeInTheDocument();
  });

  it('offers the layout binding picker, scoped to the lead for the preselect', () => {
    setup(
      [
        { ...widget('a', 'MultiA'), layout: varWidth('ds:a') },
        { ...widget('b', 'MultiA'), layout: varWidth('ds:b') },
      ],
      ['a', 'b'],
    );

    fireEvent.click(screen.getByTitle('Change variable binding'));

    const target = useEditorDomainStore.getState().bindingPickerTarget;
    expect(useEditorDomainStore.getState().bindingPickerOpen).toBe(true);
    expect(target?.componentId).toBe('a');
    expect(target?.currentBinding).toEqual({ path: 'ds:a' });
  });

  it('applies a picked layout binding to every selected widget', () => {
    setup(
      [
        { ...widget('a', 'MultiA'), layout: varWidth('ds:a') },
        { ...widget('b', 'MultiA'), layout: varWidth('ds:b') },
      ],
      ['a', 'b'],
    );

    fireEvent.click(screen.getByTitle('Change variable binding'));
    useEditorDomainStore.getState().bindingPickerTarget?.onPick?.({ path: 'ds:shared' });

    expect(layoutOf('a').width).toEqual({ $var: { path: 'ds:shared' } });
    expect(layoutOf('b').width).toEqual({ $var: { path: 'ds:shared' } });
    expect(propsOf('a')).not.toHaveProperty('__layout__.width');
  });

  it('applies a picked property binding to every selected widget', () => {
    setup(
      [
        widget('a', 'MultiA', { label: { $var: { path: 'ds:a' } } }),
        widget('b', 'MultiA', { label: { $var: { path: 'ds:b' } } }),
      ],
      ['a', 'b'],
    );

    fireEvent.click(screen.getByTitle('Change variable binding'));
    useEditorDomainStore.getState().bindingPickerTarget?.onPick?.({ path: 'ds:shared' });

    expect(propsOf('a').label).toEqual({ $var: { path: 'ds:shared' } });
    expect(propsOf('b').label).toEqual({ $var: { path: 'ds:shared' } });
  });

  it('clears a property binding on every selected widget', () => {
    setup(
      [
        widget('a', 'MultiA', { label: { $var: { path: 'ds:a' } } }),
        widget('b', 'MultiA', { label: { $var: { path: 'ds:b' } } }),
      ],
      ['a', 'b'],
    );

    fireEvent.click(screen.getByTitle('Change variable binding'));
    // The picker's Clear empties the binding through the same `onPick`.
    useEditorDomainStore.getState().bindingPickerTarget?.onPick?.({ path: '' });

    expect(propsOf('a').label).toEqual({ $var: { path: '' } });
    expect(propsOf('b').label).toEqual({ $var: { path: '' } });
  });

  // A named struct type (`Alarms[]`, a custom widget's declared type) renders as
  // the same binding row a single selection gets, so it must keep the same `✎`.
  it('offers the binding picker on a named struct row, not only on a bare "struct"', () => {
    setup([widget('a', 'MultiStruct'), widget('b', 'MultiStruct')], ['a', 'b']);

    fireEvent.click(screen.getByTitle('Change variable binding'));
    expect(useEditorDomainStore.getState().bindingPickerTarget?.componentId).toBe('a');

    useEditorDomainStore.getState().bindingPickerTarget?.onPick?.({ path: 'ds:alarms' });

    expect(propsOf('a').alarms).toEqual({ $var: { path: 'ds:alarms' } });
    expect(propsOf('b').alarms).toEqual({ $var: { path: 'ds:alarms' } });
  });

  it('explains a selection that is not all widgets', () => {
    setup([widget('a', 'MultiA')], ['a', 'page-1']);

    expect(screen.getByText(/2 items selected/)).toBeInTheDocument();
  });

  it('falls back to the single-widget panel for one selection', () => {
    setup([widget('a', 'MultiA')], ['a']);

    expect(screen.queryByText('2 components')).not.toBeInTheDocument();
    expect(screen.getByText('Identity')).toBeInTheDocument();
  });
});
