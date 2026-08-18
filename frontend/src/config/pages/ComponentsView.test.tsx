import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { registerComponents } from '@hmi/registry/widgetRegistry';
import { makeWidgetSlotId } from '@shared/constants/editorSentinels';
import { useComponentStore } from '@shared/store/componentStore';
import { clearCut, pendingCut, setCut } from '../components/editor/WidgetTree/cutState';
import { useComponentEditorStore } from '../store/componentEditorStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import ComponentsView from './ComponentsView';

vi.mock('@shared/hooks/useTranslations', () => ({ useTranslations: () => {} }));

// Spies on the tree-order walk while keeping its real behaviour — the view must
// skip it on a property write and repeat it when the definition's shape changes.
const flattenSpy = vi.hoisted(() => vi.fn());
vi.mock('../components/compositions/compositionTreeOps', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/compositions/compositionTreeOps')>();
  flattenSpy.mockImplementation(actual.flattenVisibleWidgets);
  return { ...actual, flattenVisibleWidgets: flattenSpy };
});
vi.mock('../components/compositions/CompositionPreview', () => ({
  default: () => <div data-testid="preview" />,
}));
vi.mock('../components/compositions/CompositionWidgetPanel', () => ({
  default: ({ comp }: { comp: { id: string } }) => <div data-testid="one">{comp.id}</div>,
}));
vi.mock('../components/compositions/CompositionMultiWidgetPanel', () => ({
  default: ({
    comps,
    onUpdate,
  }: {
    comps: { id: string; name: string }[];
    onUpdate: (ids: string[], patch: { name?: string }) => void;
  }) => (
    <div data-testid="many">
      {comps.map((c) => c.id).join(',')}
      <span data-testid="many-names">{comps.map((c) => c.name).join(',')}</span>
      <button
        onClick={() =>
          onUpdate(
            comps.map((c) => c.id),
            { name: 'typed' },
          )
        }
      >
        rename both
      </button>
    </div>
  ),
}));
vi.mock('../components/compositions/CompositionSchemaEditor', () => ({
  default: () => <div data-testid="schema" />,
}));

function definition(id: string, widgetIds: string[]): ComponentDefinition {
  return {
    id,
    name: id,
    group: null,
    componentProperties: {},
    children: widgetIds.map((widgetId) => ({ id: widgetId, type: 'Button', name: widgetId })),
  } as ComponentDefinition;
}

const INITIAL_STORE = useComponentStore.getState();

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ diagnostics: [] }) }),
  );
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useComponentStore.setState({
    components: [definition('A', ['a1', 'a2']), definition('B', ['b1', 'b2'])],
    folders: [],
    loaded: true,
    draftComponents: {},
    load: vi.fn().mockResolvedValue(undefined),
  });
  useComponentEditorStore.setState({
    activeComponentId: 'A',
    openTabIds: ['A'],
    previewTabId: null,
    collapsedIds: new Set(),
    selectedIds: ['b1'],
    selectedId: 'b1',
    selectionAnchorId: 'b1',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCut();
  registerComponents([]);
  useComponentStore.setState(INITIAL_STORE);
});

function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest('.cfg-tree-item');
  if (!el) throw new Error(`no tree row for ${label}`);
  return el as HTMLElement;
}

describe('ComponentsView context-menu verbs', () => {
  it('keeps the selection when one of its own rows is right-clicked', () => {
    useComponentEditorStore.setState({
      selectedIds: ['a1', 'a2'],
      selectedId: 'a2',
      selectionAnchorId: 'a1',
    });

    render(<ComponentsView />);
    fireEvent.contextMenu(row('a1'));

    expect(useComponentEditorStore.getState().selectedIds).toEqual(['a1', 'a2']);
    fireEvent.click(screen.getByText('Delete'));
    expect(useComponentStore.getState().draftComponents.A.children).toEqual([]);
  });

  it('re-points the selection when a row outside it is right-clicked', () => {
    useComponentEditorStore.setState({
      selectedIds: ['a1'],
      selectedId: 'a1',
      selectionAnchorId: 'a1',
    });

    render(<ComponentsView />);
    fireEvent.contextMenu(row('a2'));

    expect(useComponentEditorStore.getState().selectedIds).toEqual(['a2']);
    fireEvent.click(screen.getByText('Delete'));
    expect(
      (useComponentStore.getState().draftComponents.A.children as { id: string }[]).map(
        (c) => c.id,
      ),
    ).toEqual(['a1']);
  });
});

describe('ComponentsView paste against a pending cut', () => {
  /** Paste a two-widget envelope onto a3, with `cut` recorded by someone else. */
  async function pasteEnvelopeOnA3(): Promise<string[]> {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(
          JSON.stringify({
            $hmiClipboard: 1,
            nodes: [
              { id: 'a1', type: 'Button', name: 'a1' },
              { id: 'a2', type: 'Button', name: 'a2' },
            ],
          }),
        ),
      },
      configurable: true,
    });
    useComponentStore.setState({ components: [definition('A', ['a1', 'a2', 'a3'])] });
    useComponentEditorStore.setState({
      selectedIds: ['a3'],
      selectedId: 'a3',
      selectionAnchorId: 'a3',
    });

    render(<ComponentsView />);
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(useComponentStore.getState().draftComponents.A).toBeDefined());
    return (useComponentStore.getState().draftComponents.A.children as { id: string }[]).map(
      (c) => c.id,
    );
  }

  it('clones when the payload covers only part of the cut', async () => {
    setCut(['a1', 'a2', 'a3'], 'widget');

    const ids = await pasteEnvelopeOnA3();

    // A move would have kept the ids and cleared the cut, dropping a3 from it.
    expect(ids.slice(0, 3)).toEqual(['a1', 'a2', 'a3']);
    expect(ids).toHaveLength(5);
    expect(pendingCut()?.nodeIds.size).toBe(3);
  });

  it('clones when the cut was recorded for another kind of node', async () => {
    setCut(['a1', 'a2'], 'page-group');

    const ids = await pasteEnvelopeOnA3();

    expect(ids.slice(0, 3)).toEqual(['a1', 'a2', 'a3']);
    expect(ids).toHaveLength(5);
    expect(pendingCut()?.kind).toBe('page-group');
  });
});

describe('ComponentsView multi-selection order', () => {
  it('walks the definition for a structural edit but not for a property edit', () => {
    useComponentEditorStore.setState({
      selectedIds: ['a1', 'a2'],
      selectedId: 'a2',
      selectionAnchorId: 'a1',
    });

    render(<ComponentsView />);
    expect(screen.getByTestId('many')).toHaveTextContent('a1,a2');

    flattenSpy.mockClear();
    fireEvent.contextMenu(row('a1'));
    fireEvent.click(screen.getByText('Duplicate'));
    expect(flattenSpy).toHaveBeenCalled();

    const duplicated = useComponentEditorStore.getState().selectedIds;
    expect(duplicated).toHaveLength(2);

    flattenSpy.mockClear();
    fireEvent.click(screen.getByText('rename both'));

    // The panel still shows the value just written — the walk is skipped, not the resolve.
    expect(screen.getByTestId('many-names')).toHaveTextContent('typed,typed');
    expect(screen.getByTestId('many')).toHaveTextContent(duplicated.join(','));
    expect(flattenSpy).not.toHaveBeenCalled();
  });
});

describe('ComponentsView shift-range selection', () => {
  it('extends over the rows of the active definition', () => {
    useComponentEditorStore.setState({
      selectedIds: ['a1'],
      selectedId: 'a1',
      selectionAnchorId: 'a1',
    });

    render(<ComponentsView />);
    fireEvent.click(row('a2'), { shiftKey: true });

    expect(useComponentEditorStore.getState().selectedIds).toEqual(['a1', 'a2']);
    expect(screen.getByTestId('many')).toHaveTextContent('a1,a2');
  });

  it('switches definitions instead of ranging inside an inactive one', () => {
    render(<ComponentsView />);
    fireEvent.click(row('b2'), { shiftKey: true });

    const state = useComponentEditorStore.getState();
    expect(state.activeComponentId).toBe('B');
    expect(state.selectedIds).toEqual(['b2']);
    // A range applied while A stayed active left the panel resolving b-ids
    // against A and rendering "Widget not found."
    expect(screen.getByTestId('one')).toHaveTextContent('b2');
  });

  it('falls back to a plain select when the anchor is a slot folder', () => {
    // A slot row is not part of a range's result, so slicing from it would hand
    // back every widget between it and the click — rows the user never pointed at.
    registerComponents([
      {
        id: 'card',
        name: 'Card',
        componentProperties: {},
        children: [
          { id: 's0', type: 'ComponentSlot', name: 'header', properties: { slot: 'header' } },
          { id: 's1', type: 'ComponentSlot', name: 'body', properties: { slot: 'body' } },
        ],
      } as unknown as ComponentDefinition,
    ]);
    useComponentStore.setState({
      components: [
        {
          id: 'A',
          name: 'A',
          group: null,
          componentProperties: {},
          children: [
            { id: 'a1', type: 'Button', name: 'a1' },
            { id: 'a2', type: 'Button', name: 'a2' },
            {
              id: 'card-1',
              type: '$component:card',
              name: 'Card',
              children: [{ id: 'w1', type: 'Text', name: 'w1', slot: 'header' }],
            },
          ],
        } as unknown as ComponentDefinition,
      ],
    });
    useComponentEditorStore.setState({
      selectedIds: [],
      selectedId: null,
      selectionAnchorId: makeWidgetSlotId('card-1', 'header'),
    });

    render(<ComponentsView />);
    fireEvent.click(row('a1'), { shiftKey: true });

    expect(useComponentEditorStore.getState().selectedIds).toEqual(['a1']);
  });
});
