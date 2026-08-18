import { act, render, screen } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { registerComponents, widgetRegistry } from '@hmi/registry/widgetRegistry';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { useConfigStore } from '@shared/store/configStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { useProjectStore } from '@shared/store/projectStore';
import PropertiesPanel from './index';

// Spies on the selection walk while keeping its real behaviour — the panel must skip
// it on a property write and repeat it when the tree's shape changes.
const classifySpy = vi.hoisted(() => vi.fn());
vi.mock('@config/store/domains/selectionScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@config/store/domains/selectionScope')>();
  classifySpy.mockImplementation(actual.classifySelection);
  return { ...actual, classifySelection: classifySpy };
});

function setupStores() {
  useProjectStore.setState({
    dirty: false,
    saving: false,
    saveError: null,
    past: [],
    future: [],
    _saveCallbacks: new Map(),
  });

  useTranslationStore.setState({
    languages: [{ code: 'en' }],
    translations: {},
    loaded: true,
    activeLanguage: 'en',
    dictionaries: ['Default'],
    activeDictionary: 'Default',
    _draftsByDictionary: {},
  });

  useConfigStore.setState({
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'Page 1',
        sections: {
          main: [
            {
              id: 'comp-0',
              type: 'Container',
              name: 'Main Container',
              properties: {},
              layout: {},
              children: [],
            },
            {
              id: 'comp-1',
              type: 'Button',
              name: 'Run Button',
              properties: { label: 'Start' },
              layout: {},
            },
          ],
        },
      },
    ],
    header: [],
    footer: [],
    dialogs: [],
    loaded: true,
    loadedPageIds: new Set(['page-1']),
    dirtyPageIds: new Set(),
  });
}

describe('PropertiesPanel', () => {
  beforeEach(() => {
    setupStores();
    useEditorDomainStore.setState({ selectedId: null, selectedIds: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders placeholder text when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText(/select a component/i)).toBeInTheDocument();
  });

  it('renders the component name input when a component is selected', () => {
    useEditorDomainStore.setState({ selectedId: 'comp-1' });
    render(<PropertiesPanel />);
    expect(screen.getByDisplayValue('Run Button')).toBeInTheDocument();
  });

  it('defines a visible expression field for containers', () => {
    expect(widgetRegistry.Container.schema.visible).toEqual({
      type: 'Boolean',
      format: 'visibility',
      label: 'Visible',
      group: 'Visibility',
      defaultValue: true,
    });
  });

  describe('multi-selection', () => {
    function twoButtons() {
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                { id: 'btn-a', type: 'Button', name: 'A', properties: { label: 'Start' } },
                { id: 'btn-b', type: 'Button', name: 'B', properties: { label: 'Stop' } },
              ],
            },
          },
        ],
      });
      useEditorDomainStore.setState({ selectedId: 'btn-b', selectedIds: ['btn-a', 'btn-b'] });
    }

    it('shows the value the widgets end up sharing after a write to all of them', () => {
      twoButtons();
      render(<PropertiesPanel />);
      expect(screen.getByPlaceholderText('Mixed')).toBeInTheDocument();

      act(() => {
        useConfigStore.getState().updateComponents(['btn-a', 'btn-b'], {
          properties: { label: 'Go' },
        });
      });

      expect(screen.getByDisplayValue('Go')).toBeInTheDocument();
    });

    it('reclassifies when a selected widget leaves the tree, selection untouched', () => {
      twoButtons();
      render(<PropertiesPanel />);
      expect(screen.queryByText(/select components to edit them together/i)).toBeNull();

      act(() => {
        useConfigStore.setState({
          pages: [
            {
              id: 'page-1',
              type: 'page',
              title: 'Page 1',
              sections: {
                main: [{ id: 'btn-a', type: 'Button', name: 'A', properties: { label: 'Start' } }],
              },
            },
          ],
        });
      });

      expect(useEditorDomainStore.getState().selectedIds).toEqual(['btn-a', 'btn-b']);
      expect(screen.getByText(/select components to edit them together/i)).toBeInTheDocument();
    });

    it('reclassifies when a store action deletes a selected widget', () => {
      twoButtons();
      render(<PropertiesPanel />);
      expect(screen.queryByText(/select components to edit them together/i)).toBeNull();

      act(() => {
        useConfigStore.getState().deleteComponent('btn-b');
      });

      expect(screen.getByText(/select components to edit them together/i)).toBeInTheDocument();
    });

    it('walks the tree for a structural change but not for a property edit', () => {
      twoButtons();
      render(<PropertiesPanel />);

      classifySpy.mockClear();
      act(() => {
        useConfigStore.getState().updateComponents(['btn-a', 'btn-b'], {
          properties: { label: 'Go' },
        });
      });
      // The rows still show the written value — the walk is skipped, not the resolve.
      expect(screen.getByDisplayValue('Go')).toBeInTheDocument();
      expect(classifySpy).not.toHaveBeenCalled();

      act(() => {
        useConfigStore.getState().addComponentToPage('page-1', {
          id: 'btn-c',
          type: 'Button',
          name: 'C',
        });
      });
      expect(classifySpy).toHaveBeenCalled();
    });
  });

  it('marks Visible as the resolved default when unset in static mode', () => {
    useEditorDomainStore.setState({ selectedId: 'comp-0' });

    render(<PropertiesPanel />);

    // Unset boolean with defaultValue:true — the True option is marked as the
    // default in effect (not an explicit selection), and False dims.
    const visibleBtn = screen.getByRole('button', { name: 'Visible' });
    expect(visibleBtn).toHaveClass('cfg-seg-btn--default');
    expect(visibleBtn).not.toHaveClass('cfg-seg-btn--active');
    expect(screen.getByRole('button', { name: 'Hidden' })).toHaveClass('cfg-seg-btn--alt');
  });

  describe('a component instance with a declared slot', () => {
    beforeEach(() => {
      registerComponents([
        {
          id: 'card',
          name: 'Card',
          componentProperties: { body: { type: 'widgets', label: 'Body' } },
          children: [{ id: 's0', type: 'ComponentSlot', properties: { slot: 'body' } }],
        } as unknown as ComponentDefinition,
      ]);
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                {
                  id: 'card-1',
                  type: '$component:card',
                  name: 'Card',
                  children: [{ id: 'lbl', type: 'Label', name: 'Heading', slot: 'body' }],
                },
              ],
            },
          },
        ],
      });
      useEditorDomainStore.setState({ selectedId: 'card-1', selectedIds: ['card-1'] });
    });

    afterEach(() => registerComponents([]));

    it('omits the slot — its content is tree children, not a property value', () => {
      render(<PropertiesPanel />);

      expect(screen.queryByText('Body')).not.toBeInTheDocument();
      expect(screen.queryByText('Heading')).not.toBeInTheDocument();
      // The section the slot was the only field of goes with it.
      expect(screen.queryByText('Properties')).not.toBeInTheDocument();
    });
  });
});
