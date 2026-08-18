import { projectFromStore } from '@config/components/editor/WidgetTree/clipboardDispatch';
import { resolveDropTarget, type DropBand } from '@config/components/editor/WidgetTree/dropTarget';
import { useConfigStore } from './configStore';
import { useProjectStore } from './projectStore';
import { useTranslationStore } from './translationStore';

describe('configStore', () => {
  beforeEach(() => {
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
                id: 'comp-1',
                type: 'Button',
                name: 'Button 1',
                properties: { label: 'Start', color: '#111111' },
                layout: { basis: '10rem', grow: 0 },
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shallow merges component properties and layout during updateComponent', () => {
    useConfigStore.getState().updateComponent('comp-1', {
      name: 'Run Button',
      properties: { label: 'Run' },
      layout: { grow: 1 },
    });

    const firstPage = useConfigStore.getState().pages[0];
    const sections = firstPage && 'sections' in firstPage ? firstPage.sections : undefined;
    const widgets = sections?.main ?? [];
    const component = widgets.find((w) => w.id === 'comp-1');
    expect(component?.name).toBe('Run Button');
    expect(component?.properties).toEqual({ label: 'Run', color: '#111111' });
    expect(component?.layout).toEqual({ basis: '10rem', grow: 1 });
  });

  describe('updateComponents', () => {
    function widgetsOf(pageId: string) {
      const page = useConfigStore.getState().pages.find((p) => p.id === pageId);
      return page && 'sections' in page ? Object.values(page.sections).flat() : [];
    }

    beforeEach(() => {
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                { id: 'comp-1', type: 'Button', name: 'One', properties: { label: 'A' } },
                {
                  id: 'box',
                  type: 'Container',
                  name: 'Box',
                  children: [{ id: 'comp-2', type: 'Button', name: 'Two', properties: {} }],
                },
              ],
            },
          },
          {
            id: 'page-2',
            type: 'page',
            title: 'Page 2',
            sections: { main: [{ id: 'comp-3', type: 'Button', name: 'Three' }] },
          },
        ],
        dirtyPageIds: new Set(),
      });
    });

    it('applies one patch to every listed component, wherever it lives', () => {
      useConfigStore.getState().updateComponents(['comp-1', 'comp-2'], {
        properties: { color: '#fff' },
      });

      const widgets = widgetsOf('page-1');
      expect(widgets.find((w) => w.id === 'comp-1')?.properties).toEqual({
        label: 'A',
        color: '#fff',
      });
      expect(widgets.find((w) => w.id === 'box')?.children?.[0].properties).toEqual({
        color: '#fff',
      });
    });

    it('leaves components outside the list untouched', () => {
      useConfigStore.getState().updateComponents(['comp-1'], { properties: { color: '#fff' } });

      expect(widgetsOf('page-2')[0].properties).toBeUndefined();
    });

    it('marks every owning page dirty', () => {
      useConfigStore.getState().updateComponents(['comp-1', 'comp-3'], { layout: { grow: 1 } });

      expect(useConfigStore.getState().dirtyPageIds).toEqual(new Set(['page-1', 'page-2']));
    });

    it('pushes a single undo entry for the whole fan-out', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      useConfigStore.getState().updateComponents(['comp-1', 'comp-2', 'comp-3'], {
        properties: { color: '#fff' },
      });

      expect(useProjectStore.getState().past).toHaveLength(1);
    });

    it('does nothing for an empty list', () => {
      const before = useConfigStore.getState().pages;

      useConfigStore.getState().updateComponents([], { properties: { color: '#fff' } });

      expect(useConfigStore.getState().pages).toBe(before);
    });
  });

  describe('structureRev', () => {
    const rev = () => useConfigStore.getState().structureRev;

    beforeEach(() => {
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                { id: 'one', type: 'Button', name: 'One' },
                {
                  id: 'box',
                  type: 'Container',
                  name: 'Box',
                  children: [{ id: 'inner', type: 'Button', name: 'Inner' }],
                },
              ],
            },
          },
          { id: 'grp', type: 'page-group', title: 'Group', children: [], header: [], footer: [] },
        ],
        header: [{ id: 'head', type: 'Button', name: 'Head' }],
        footer: [],
        dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [] }],
        loadedPageIds: new Set(['page-1']),
        dirtyPageIds: new Set(),
      });
    });

    /** Each entry runs against the fixture above and must leave the counter higher. */
    const advances: Array<[string, () => void]> = [
      [
        'addComponentToPage',
        () => useConfigStore.getState().addComponentToPage('page-1', newBtn()),
      ],
      [
        'addComponentToPageSection',
        () => useConfigStore.getState().addComponentToPageSection('page-1', 'main', newBtn()),
      ],
      [
        'addComponentToPageGroupArea',
        () => useConfigStore.getState().addComponentToPageGroupArea('grp', 'header', newBtn()),
      ],
      [
        'addComponentToArea',
        () => useConfigStore.getState().addComponentToArea('header', newBtn()),
      ],
      [
        'addComponentToDialog',
        () => useConfigStore.getState().addComponentToDialog('dlg', newBtn()),
      ],
      [
        'addComponentToContainer',
        () => useConfigStore.getState().addComponentToContainer('box', newBtn()),
      ],
      [
        'addComponentToWidgetSlot',
        () => useConfigStore.getState().addComponentToWidgetSlot('box', 'slot', newBtn()),
      ],
      ['deleteComponent', () => useConfigStore.getState().deleteComponent('one')],
      ['deleteComponents', () => useConfigStore.getState().deleteComponents(['one', 'head'])],
      ['duplicateComponent', () => useConfigStore.getState().duplicateComponent('one')],
      ['duplicateComponents', () => useConfigStore.getState().duplicateComponents(['one', 'head'])],
      [
        'moveWidgetTo',
        () =>
          useConfigStore.getState().moveWidgetTo('one', { kind: 'container', containerId: 'box' }),
      ],
      [
        'moveWidgetsTo',
        () =>
          useConfigStore
            .getState()
            .moveWidgetsTo(['one', 'head'], { kind: 'container', containerId: 'box' }),
      ],
      [
        'reorderChildren',
        () =>
          useConfigStore
            .getState()
            .reorderChildren('box', [{ id: 'inner', type: 'Button', name: 'Inner' }]),
      ],
      [
        'setPageSections',
        () => useConfigStore.getState().setPageSections('page-1', { main: [newBtn()] }),
      ],
      [
        'reorderPageChildren',
        () => useConfigStore.getState().reorderPageChildren('page-1', [newBtn()]),
      ],
      [
        'addPage',
        () =>
          useConfigStore
            .getState()
            .addPage({ id: 'page-2', type: 'page', title: 'P2', sections: { main: [] } }),
      ],
      ['deletePage', () => useConfigStore.getState().deletePage('page-1')],
      [
        'addPageToPageGroup',
        () =>
          useConfigStore
            .getState()
            .addPageToPageGroup('grp', { id: 'page-3', type: 'page', title: 'P3', sections: {} }),
      ],
      [
        'addPageGroup',
        () =>
          useConfigStore
            .getState()
            .addPageGroup({ id: 'grp-2', type: 'page-group', title: 'G2', children: [] }),
      ],
      [
        'addPageGroupToPageGroup',
        () =>
          useConfigStore.getState().addPageGroupToPageGroup('grp', {
            id: 'grp-3',
            type: 'page-group',
            title: 'G3',
            children: [],
          }),
      ],
      ['deletePageGroup', () => useConfigStore.getState().deletePageGroup('grp')],
      [
        'reorderPageGroupChildren',
        () => useConfigStore.getState().reorderPageGroupChildren('grp', []),
      ],
      ['movePageTo', () => useConfigStore.getState().movePageTo('page-1', 'grp')],
      [
        'reorderPages',
        () =>
          useConfigStore.getState().reorderPages([...useConfigStore.getState().pages].reverse()),
      ],
      [
        'addDialog',
        () => useConfigStore.getState().addDialog({ id: 'dlg-2', title: 'D2', widgets: [] }),
      ],
      ['deleteDialog', () => useConfigStore.getState().deleteDialog('dlg')],
      // The paste path splices into page-group chrome through updatePageGroup.
      [
        'updatePageGroup with chrome widgets',
        () => useConfigStore.getState().updatePageGroup('grp', { header: [newBtn()] }),
      ],
      ['restoreAreas', () => useConfigStore.getState().restoreAreas(useConfigStore.getState())],
      ['setPages', () => useConfigStore.getState().setPages([])],
      ['setHeader', () => useConfigStore.getState().setHeader([])],
      ['setFooter', () => useConfigStore.getState().setFooter([])],
      ['setLeftSidebar', () => useConfigStore.getState().setLeftSidebar([])],
      ['setRightSidebar', () => useConfigStore.getState().setRightSidebar([])],
      ['setDialogs', () => useConfigStore.getState().setDialogs([])],
    ];

    let seq = 0;
    function newBtn() {
      seq += 1;
      return { id: `added-${seq}`, type: 'Button', name: `Added ${seq}` };
    }

    it.each(advances)('advances for %s', (_label, mutate) => {
      const before = rev();

      mutate();

      expect(rev()).toBeGreaterThan(before);
    });

    it('advances when a lazily loaded page brings its widgets in', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ sections: { main: [{ id: 'lazy', type: 'Button' }] } }),
        }),
      );
      useConfigStore.setState({ loadedPageIds: new Set() });
      const before = rev();

      await useConfigStore.getState().loadPageContent('page-1');

      expect(rev()).toBeGreaterThan(before);
    });

    /** Property-value edits — the whole reason the counter exists is that these
     *  rewrite widget objects without moving one. */
    const holds: Array<[string, () => void]> = [
      [
        'updateComponent',
        () => useConfigStore.getState().updateComponent('one', { properties: { label: 'x' } }),
      ],
      [
        'updateComponents',
        () =>
          useConfigStore
            .getState()
            .updateComponents(['one', 'inner'], { properties: { label: 'x' } }),
      ],
      [
        'updateComponent layout',
        () => useConfigStore.getState().updateComponent('one', { layout: { grow: 1 } }),
      ],
      ['updatePage', () => useConfigStore.getState().updatePage('page-1', { title: 'Renamed' })],
      ['renameDialog', () => useConfigStore.getState().renameDialog('dlg', 'Renamed')],
      [
        'updateDialog',
        () => useConfigStore.getState().updateDialog('dlg', { showCloseButton: true }),
      ],
      ['updateShell', () => useConfigStore.getState().updateShell({ hmiScale: 2 })],
      ['updateGlobalEvents', () => useConfigStore.getState().updateGlobalEvents({})],
      ['markLoaded', () => useConfigStore.getState().markLoaded()],
    ];

    it.each(holds)('holds steady for %s', (_label, mutate) => {
      const before = rev();

      mutate();

      expect(rev()).toBe(before);
    });

    it('is not part of the project sent to the backend', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal('fetch', fetchSpy);
      useConfigStore.getState().addComponentToPage('page-1', newBtn());
      expect(rev()).toBeGreaterThan(0);

      await useConfigStore.getState().saveConfigToBackend();

      expect(fetchSpy).toHaveBeenCalled();
      for (const call of fetchSpy.mock.calls) {
        expect(JSON.stringify(call[1] ?? {})).not.toContain('structureRev');
      }
    });

    it('is not part of an undo snapshot', () => {
      useProjectStore.setState({ past: [], future: [] });

      useConfigStore.getState().addComponentToPage('page-1', newBtn());

      const [snapshot] = useProjectStore.getState().past;
      expect(snapshot).toBeDefined();
      expect(Object.keys(snapshot)).not.toContain('structureRev');
    });

    it('keeps rising across an undo, so a restored tree is never mistaken for the current one', () => {
      useProjectStore.setState({ past: [], future: [] });
      useConfigStore.getState().addComponentToPage('page-1', newBtn());
      const afterAdd = rev();

      useProjectStore.getState().undo();

      expect(rev()).toBeGreaterThan(afterAdd);
    });
  });

  describe('deleteComponents and duplicateComponents', () => {
    function pageWidgets(state: ReturnType<typeof useConfigStore.getState>, pageId: string) {
      const page = state.pages.find((p) => p.id === pageId);
      return page && 'sections' in page ? Object.values(page.sections).flat() : [];
    }

    function idsOf(pageId: string) {
      return pageWidgets(useConfigStore.getState(), pageId).map((w) => w.id);
    }

    beforeEach(() => {
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                { id: 'one', type: 'Button', name: 'One' },
                {
                  id: 'box',
                  type: 'Container',
                  name: 'Box',
                  children: [{ id: 'inner', type: 'Button', name: 'Inner' }],
                },
                { id: 'two', type: 'Button', name: 'Two' },
              ],
            },
          },
        ],
        header: [{ id: 'head', type: 'Button', name: 'Head' }],
        dirtyPageIds: new Set(),
      });
    });

    it('deletes every listed widget across areas in one step', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      useConfigStore.getState().deleteComponents(['one', 'inner', 'head']);

      expect(idsOf('page-1')).toEqual(['box', 'two']);
      expect(useConfigStore.getState().header).toEqual([]);
      expect(useProjectStore.getState().past).toHaveLength(1);
    });

    it('leaves the tree untouched for an empty list', () => {
      const before = useConfigStore.getState().pages;

      useConfigStore.getState().deleteComponents([]);

      expect(useConfigStore.getState().pages).toBe(before);
    });

    it('reports every id it took out, descendants of a deleted container included', () => {
      // What the tree prunes its selection with: an id that went as a descendant is
      // reported, one that was never a widget is not.
      const removed = useConfigStore.getState().deleteComponents(['box', 'head', 'no-such-row']);

      expect(removed).toEqual(new Set(['box', 'inner', 'head']));
    });

    it('reports the removed id for a single delete too', () => {
      expect(useConfigStore.getState().deleteComponents(['one'])).toEqual(new Set(['one']));
    });

    /** One pass for the whole batch: everything the delete did not reach keeps the
     *  object it had, so one user action hands React one generation of identities
     *  instead of one per deleted widget. */
    it('rebuilds only the areas a batch delete reached', () => {
      useConfigStore.setState((s) => ({
        pages: [
          ...s.pages,
          { id: 'page-2', type: 'page', title: 'Page 2', sections: { main: [] } },
        ],
        dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [] }],
        footer: [],
      }));
      const before = useConfigStore.getState();
      const boxBefore = pageWidgets(before, 'page-1').find((w) => w.id === 'box');

      useConfigStore.getState().deleteComponents(['one', 'two', 'head']);

      const after = useConfigStore.getState();
      expect(after.pages[1]).toBe(before.pages[1]);
      expect(after.dialogs).toBe(before.dialogs);
      expect(after.footer).toBe(before.footer);
      expect(pageWidgets(after, 'page-1').find((w) => w.id === 'box')).toBe(boxBefore);
    });

    it('rebuilds only the areas a batch duplicate reached', () => {
      useConfigStore.setState((s) => ({
        pages: [
          ...s.pages,
          { id: 'page-2', type: 'page', title: 'Page 2', sections: { main: [] } },
        ],
        dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [] }],
      }));
      const before = useConfigStore.getState();
      const boxBefore = pageWidgets(before, 'page-1').find((w) => w.id === 'box');

      useConfigStore.getState().duplicateComponents(['one', 'two']);

      const after = useConfigStore.getState();
      expect(after.pages[1]).toBe(before.pages[1]);
      expect(after.dialogs).toBe(before.dialogs);
      expect(after.header).toBe(before.header);
      expect(pageWidgets(after, 'page-1').find((w) => w.id === 'box')).toBe(boxBefore);
    });

    it('rebuilds only the areas a batch move reached', () => {
      useConfigStore.setState((s) => ({
        pages: [
          ...s.pages,
          { id: 'page-2', type: 'page', title: 'Page 2', sections: { main: [] } },
        ],
        dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [] }],
      }));
      const before = useConfigStore.getState();

      useConfigStore
        .getState()
        .moveWidgetsTo(['one', 'two'], { kind: 'container', containerId: 'box' });

      const after = useConfigStore.getState();
      expect(after.pages[1]).toBe(before.pages[1]);
      expect(after.dialogs).toBe(before.dialogs);
      expect(after.header).toBe(before.header);
    });

    it('leaves no trace when every widget of a duplicate is already gone', () => {
      // Same class as the vanished move: the menu was opened before another tab (or
      // an undo) took the widgets away. An undo step that undoes nothing, a save
      // indicator for an edit that never happened, and a revision bump that
      // invalidates every memo keyed on it.
      const before = useConfigStore.getState().structureRev;

      const newIds = useConfigStore.getState().duplicateComponents(['gone-1', 'gone-2']);

      expect(newIds).toEqual([]);
      expect(useProjectStore.getState().past).toEqual([]);
      expect(useProjectStore.getState().dirty).toBe(false);
      expect(useConfigStore.getState().structureRev).toBe(before);
    });

    it('leaves no trace when the widget of a single duplicate is already gone', () => {
      const before = useConfigStore.getState().structureRev;

      useConfigStore.getState().duplicateComponent('gone-1');

      expect(useProjectStore.getState().past).toEqual([]);
      expect(useProjectStore.getState().dirty).toBe(false);
      expect(useConfigStore.getState().structureRev).toBe(before);
    });

    it('lands each clone directly after its own original', () => {
      const newIds = useConfigStore.getState().duplicateComponents(['one', 'two']);

      expect(idsOf('page-1')).toEqual(['one', newIds[0], 'box', 'two', newIds[1]]);
    });

    it('returns the new ids in the order the originals were given', () => {
      const newIds = useConfigStore.getState().duplicateComponents(['one', 'two']);

      expect(newIds).toHaveLength(2);
      expect(idsOf('page-1').indexOf(newIds[0])).toBeLessThan(idsOf('page-1').indexOf(newIds[1]));
    });

    it('gives every clone in a batch a distinct id', () => {
      const newIds = useConfigStore.getState().duplicateComponents(['one', 'two', 'box']);

      expect(new Set(newIds).size).toBe(3);
    });

    it('resolves the duplicate against the store as it stands, not a read taken at entry', () => {
      // A write that lands between the action reading the store and writing it
      // back — a lazily loaded page arriving, say — must survive the duplicate.
      const realSetState = useConfigStore.setState;
      vi.spyOn(useConfigStore, 'setState').mockImplementationOnce((partial, replace) => {
        realSetState({ loadedPageIds: new Set(['page-1', 'page-late']) });
        realSetState(partial, replace);
      });

      useConfigStore.getState().duplicateComponents(['one', 'two']);

      expect(useConfigStore.getState().loadedPageIds.has('page-late')).toBe(true);
      expect(idsOf('page-1')).toHaveLength(5);
    });

    it('duplicates a nested widget in place', () => {
      const newIds = useConfigStore.getState().duplicateComponents(['inner']);

      const page = useConfigStore.getState().pages[0];
      const box = ('sections' in page ? page.sections.main : []).find((w) => w.id === 'box');
      expect(box?.children?.map((c) => c.id)).toEqual(['inner', newIds[0]]);
    });

    it('lands a multi move contiguously, in the order given', () => {
      useConfigStore
        .getState()
        .moveWidgetsTo(['one', 'two'], { kind: 'container', containerId: 'box' });

      const page = useConfigStore.getState().pages[0];
      const box = ('sections' in page ? page.sections.main : []).find((w) => w.id === 'box');
      expect(box?.children?.map((c) => c.id)).toEqual(['inner', 'one', 'two']);
      expect(idsOf('page-1')).toEqual(['box']);
    });

    /** The whole drag path — the plan the tree resolves, applied by the store —
     *  since the plan's index is what says where a batch lands. */
    function applyDrop(nodeIds: string[], overId: string, band: DropBand) {
      const project = projectFromStore();
      const plan = resolveDropTarget(project, nodeIds[0], overId, band, nodeIds);
      if (plan?.kind !== 'widget') throw new Error(`no widget drop on ${overId}`);
      useConfigStore.getState().moveWidgetsTo(nodeIds, plan.target, plan.index);
    }

    it('lands a batch where the drop indicator showed it', () => {
      // 'one' and 'box' both sit above 'two' in the same list, so an index taken
      // before the sweep would land the pair short.
      applyDrop(['one', 'box'], 'two', 'bottom');

      expect(idsOf('page-1')).toEqual(['two', 'one', 'box']);
    });

    it('keeps a batch at the drop point when the row it was dropped on moves with it', () => {
      // Dropped on 'two's top edge while 'two' is part of the batch: the row is
      // swept out with the pair, and an append would land them after 'box'.
      applyDrop(['one', 'two'], 'two', 'top');

      expect(idsOf('page-1')).toEqual(['box', 'one', 'two']);
    });

    it('leaves no trace when every widget of the move is already gone', () => {
      // Dropped after another tab (or an undo) took the dragged widgets away: an
      // undo step that undoes nothing, a save indicator for an edit that never
      // happened, and a revision bump that invalidates every memo keyed on it.
      const before = useConfigStore.getState().structureRev;

      useConfigStore
        .getState()
        .moveWidgetsTo(['gone-1', 'gone-2'], { kind: 'container', containerId: 'box' });

      expect(useProjectStore.getState().past).toEqual([]);
      expect(useProjectStore.getState().dirty).toBe(false);
      expect(useConfigStore.getState().structureRev).toBe(before);
    });

    it('refuses a move into a widget the same move takes away', () => {
      // 'inner' lives inside 'box', which is moving too: the insert would look for a
      // parent the sweep has already removed and both widgets would be lost.
      useConfigStore
        .getState()
        .moveWidgetsTo(['box', 'one'], { kind: 'container', containerId: 'inner' });

      expect(idsOf('page-1')).toEqual(['one', 'box', 'two']);
      expect(useProjectStore.getState().past).toHaveLength(0);
    });

    it('refuses a move into one of the moved widgets itself', () => {
      useConfigStore
        .getState()
        .moveWidgetsTo(['box', 'one'], { kind: 'container', containerId: 'box' });

      expect(idsOf('page-1')).toEqual(['one', 'box', 'two']);
      expect(useProjectStore.getState().past).toHaveLength(0);
    });

    it('clears a stale slot tag when the target has no slots', () => {
      useConfigStore.setState({
        pages: [
          {
            id: 'page-1',
            type: 'page',
            title: 'Page 1',
            sections: {
              main: [
                { id: 'one', type: 'Button', name: 'One', slot: 'header' },
                { id: 'two', type: 'Button', name: 'Two', slot: 'header' },
                { id: 'box', type: 'Container', name: 'Box', children: [] },
              ],
            },
          },
        ],
      });

      useConfigStore
        .getState()
        .moveWidgetsTo(['one', 'two'], { kind: 'container', containerId: 'box' });

      const page = useConfigStore.getState().pages[0];
      const box = ('sections' in page ? page.sections.main : []).find((w) => w.id === 'box');
      expect(box?.children?.every((c) => c.slot === undefined)).toBe(true);
    });

    it('records a multi move as one undo step', () => {
      useConfigStore
        .getState()
        .moveWidgetsTo(['one', 'two'], { kind: 'container', containerId: 'box' });

      expect(useProjectStore.getState().past).toHaveLength(1);
      useProjectStore.getState().undo();
      expect(idsOf('page-1')).toEqual(['one', 'box', 'two']);
    });

    it('records the whole duplicate batch as one undo step', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      useConfigStore.getState().duplicateComponents(['one', 'two']);

      expect(useProjectStore.getState().past).toHaveLength(1);
      useProjectStore.getState().undo();
      expect(idsOf('page-1')).toEqual(['one', 'box', 'two']);
    });
  });

  it('skips page save when config was never loaded', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    useConfigStore.setState({ loaded: false });

    const result = await useConfigStore.getState().saveConfigToBackend();

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves index and dirty pages on saveConfigToBackend', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchSpy);
    useConfigStore.setState({ dirtyPageIds: new Set(['page-1']) });

    const result = await useConfigStore.getState().saveConfigToBackend();

    expect(result).toBe(true);
    // Should call PUT /api/config/config for the index
    const indexCall = fetchSpy.mock.calls.find(
      (call) => call[0] === '/api/config/config' && call[1]?.method === 'PUT',
    );
    expect(indexCall).toBeTruthy();
    // Should call PUT /api/config/pages/page-1 for the dirty page
    const pageCall = fetchSpy.mock.calls.find(
      (call) => call[0] === '/api/config/pages/page-1' && call[1]?.method === 'PUT',
    );
    expect(pageCall).toBeTruthy();
    // dirtyPageIds should be cleared
    expect(useConfigStore.getState().dirtyPageIds.size).toBe(0);
  });

  it('does not fail the save when the config response carries advisory warnings', async () => {
    // Advisory issues (e.g. unknown $var datasource) never block a write —
    // the PUT response no longer even carries a `warnings` field (see
    // GET /api/config/validate), but a save must still succeed regardless.
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes('/api/config/config')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 204 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    useConfigStore.setState({ dirtyPageIds: new Set() });

    const ok = await useConfigStore.getState().saveConfigToBackend();

    expect(ok).toBe(true);
  });

  it('keeps a failed page dirty while clearing successful siblings', async () => {
    useConfigStore.setState({
      pages: [
        { id: 'page-1', type: 'page', title: 'P1', sections: { main: [] } },
        { id: 'page-2', type: 'page', title: 'P2', sections: { main: [] } },
      ],
      loadedPageIds: new Set(['page-1', 'page-2']),
      dirtyPageIds: new Set(['page-1', 'page-2']),
    });
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes('/api/config/config')) {
        return Promise.resolve({ ok: true, status: 204 });
      }
      if (url.includes('/pages/page-1')) {
        return Promise.resolve({ ok: true, status: 204 });
      }
      // page-2 fails
      return Promise.resolve({ ok: false, status: 500, json: async () => ({ detail: 'boom' }) });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await useConfigStore.getState().saveConfigToBackend();

    // A failing page makes the overall save fail…
    expect(ok).toBe(false);
    // …but the successful sibling is cleared (allSettled), while the failed
    // page stays dirty for a retry.
    expect(useConfigStore.getState().dirtyPageIds.has('page-1')).toBe(false);
    expect(useConfigStore.getState().dirtyPageIds.has('page-2')).toBe(true);
  });

  it('preserves a page dirtied during the in-flight save', async () => {
    useConfigStore.setState({
      pages: [
        { id: 'page-1', type: 'page', title: 'P1', sections: { main: [] } },
        { id: 'page-2', type: 'page', title: 'P2', sections: { main: [] } },
      ],
      loadedPageIds: new Set(['page-1', 'page-2']),
      dirtyPageIds: new Set(['page-1']),
    });
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes('/api/config/config')) {
        // Simulate a concurrent edit dirtying another page mid-save.
        useConfigStore.setState((s) => ({ dirtyPageIds: new Set([...s.dirtyPageIds, 'page-2']) }));
        return Promise.resolve({ ok: true, status: 204 });
      }
      return Promise.resolve({ ok: true, status: 204 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await useConfigStore.getState().saveConfigToBackend();

    expect(ok).toBe(true);
    // page-1 saved and cleared; page-2 was dirtied during the save and must remain.
    expect(useConfigStore.getState().dirtyPageIds.has('page-1')).toBe(false);
    expect(useConfigStore.getState().dirtyPageIds.has('page-2')).toBe(true);
  });

  it('loadPageContent hydrates page children from API', async () => {
    const children = [{ id: 'comp-x', type: 'Label', name: 'X', properties: {}, layout: {} }];
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'page-1', sections: { main: children } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    // Reset to unloaded state for page-1
    useConfigStore.setState({ loadedPageIds: new Set(), dirtyPageIds: new Set() });

    await useConfigStore.getState().loadPageContent('page-1');

    const firstPage = useConfigStore.getState().pages[0];
    const sections = firstPage && 'sections' in firstPage ? firstPage.sections : undefined;
    expect(sections?.main).toEqual(children);
    expect(useConfigStore.getState().loadedPageIds.has('page-1')).toBe(true);
  });

  it('loadPageContent falls back to an empty content section for the missing-page stub', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'page-1', sections: { content: [] } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    useConfigStore.setState({ loadedPageIds: new Set(), dirtyPageIds: new Set() });

    await useConfigStore.getState().loadPageContent('page-1');

    const firstPage = useConfigStore.getState().pages[0];
    const sections = firstPage && 'sections' in firstPage ? firstPage.sections : undefined;
    expect(sections).toEqual({ content: [] });
  });

  it('loadPageContent drops non-array section values from a malformed response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'page-1', sections: { main: 'not-an-array', content: null } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    useConfigStore.setState({ loadedPageIds: new Set(), dirtyPageIds: new Set() });

    await useConfigStore.getState().loadPageContent('page-1');

    const firstPage = useConfigStore.getState().pages[0];
    const sections = firstPage && 'sections' in firstPage ? firstPage.sections : undefined;
    expect(sections).toEqual({ content: [] });
  });

  it('setPages normalizes raw bootstrap nodes missing title or sections', () => {
    useConfigStore
      .getState()
      .setPages([
        { id: 'page-1', title: 'Page 1' },
        { id: 'no-title' },
        { id: 'page-2', title: 'Page 2', sections: { content: [] } },
      ]);

    const { pages } = useConfigStore.getState();
    expect(pages.map((p) => p.id)).toEqual(['page-1', 'page-2']);
    const firstPage = pages[0];
    const sections = firstPage && 'sections' in firstPage ? firstPage.sections : undefined;
    expect(sections).toEqual({ content: [] });
  });

  it('moves a widget into a page section of another page, keeping its id', () => {
    useConfigStore.setState({
      pages: [
        ...useConfigStore.getState().pages,
        { id: 'page-2', type: 'page', title: 'Page 2', sections: { header: [], content: [] } },
      ],
    });

    useConfigStore
      .getState()
      .moveWidgetTo('comp-1', { kind: 'page-section', pageId: 'page-2', sectionId: 'header' });

    const [source, target] = useConfigStore.getState().pages;
    expect('sections' in source ? source.sections.main : null).toEqual([]);
    const moved = 'sections' in target ? target.sections.header : [];
    expect(moved.map((w) => w.id)).toEqual(['comp-1']);
    expect(useConfigStore.getState().dirtyPageIds).toEqual(new Set(['page-1', 'page-2']));
  });

  it('honours the index when moving a widget into a container, and clears a stale slot tag', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page 1',
          sections: {
            main: [
              {
                id: 'box',
                type: 'Container',
                name: 'Box',
                children: [
                  { id: 'first', type: 'Label', name: 'First' },
                  { id: 'second', type: 'Label', name: 'Second' },
                ],
              },
              { id: 'moved', type: 'Button', name: 'Btn', slot: 'header' },
            ],
          },
        },
      ],
    });

    useConfigStore.getState().moveWidgetTo('moved', { kind: 'container', containerId: 'box' }, 1);

    const page = useConfigStore.getState().pages[0];
    const main = 'sections' in page ? page.sections.main : [];
    expect(main.map((w) => w.id)).toEqual(['box']);
    expect(main[0].children?.map((w) => w.id)).toEqual(['first', 'moved', 'second']);
    expect(main[0].children?.[1].slot).toBeUndefined();
  });

  it('moves a widget into a shell area and back out to a page', () => {
    const store = () => useConfigStore.getState();
    store().moveWidgetTo('comp-1', { kind: 'shell-area', region: 'header' });
    expect(store().header.map((w) => w.id)).toEqual(['comp-1']);

    store().moveWidgetTo('comp-1', { kind: 'page-section', pageId: 'page-1', sectionId: 'main' });
    expect(store().header).toEqual([]);
    const page = store().pages[0];
    expect('sections' in page ? page.sections.main.map((w) => w.id) : []).toEqual(['comp-1']);
  });

  it('moves a page into a page group at an index and back out to root', () => {
    useConfigStore.getState().addPageGroup({
      id: 'group-1',
      type: 'page-group',
      title: 'Group 1',
      children: [{ id: 'page-a', type: 'page', title: 'A', sections: { content: [] } }],
    });

    useConfigStore.getState().movePageTo('page-1', 'group-1', 0);

    const grouped = useConfigStore.getState().pages.find((node) => node.id === 'group-1');
    expect(
      grouped && grouped.type === 'page-group' ? grouped.children.map((c) => c.id) : [],
    ).toEqual(['page-1', 'page-a']);

    useConfigStore.getState().movePageTo('page-1', null);
    expect(useConfigStore.getState().pages.map((node) => node.id)).toEqual(['group-1', 'page-1']);
  });

  it('honours the index when moving a page into a nested page group', () => {
    useConfigStore.getState().addPageGroup({
      id: 'outer',
      type: 'page-group',
      title: 'Outer',
      children: [
        {
          id: 'inner',
          type: 'page-group',
          title: 'Inner',
          children: [
            { id: 'page-a', type: 'page', title: 'A', sections: { content: [] } },
            { id: 'page-b', type: 'page', title: 'B', sections: { content: [] } },
          ],
        },
      ],
    });

    useConfigStore.getState().movePageTo('page-1', 'inner', 1);

    const outer = useConfigStore.getState().pages.find((node) => node.id === 'outer');
    const inner =
      outer && outer.type === 'page-group'
        ? outer.children.find((c) => c.id === 'inner')
        : undefined;
    expect(inner && inner.type === 'page-group' ? inner.children.map((c) => c.id) : []).toEqual([
      'page-a',
      'page-1',
      'page-b',
    ]);
  });

  it('marks the project dirty after a move, so the change can be saved', () => {
    useProjectStore.setState({ dirty: false });

    useConfigStore.getState().moveWidgetTo('comp-1', { kind: 'shell-area', region: 'header' });

    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('refuses to move a page group into its own descendant', () => {
    useConfigStore.getState().addPageGroup({
      id: 'outer',
      type: 'page-group',
      title: 'Outer',
      children: [{ id: 'inner', type: 'page-group', title: 'Inner', children: [] }],
    });

    useConfigStore.getState().movePageTo('outer', 'inner');

    const outer = useConfigStore.getState().pages.find((node) => node.id === 'outer');
    expect(outer).toBeDefined();
    expect(outer && outer.type === 'page-group' ? outer.children.map((c) => c.id) : []).toEqual([
      'inner',
    ]);
  });

  it('records a move as a single undo step', () => {
    useConfigStore.setState({
      pages: [
        ...useConfigStore.getState().pages,
        { id: 'page-2', type: 'page', title: 'Page 2', sections: { content: [] } },
      ],
    });

    useConfigStore
      .getState()
      .moveWidgetTo('comp-1', { kind: 'page-section', pageId: 'page-2', sectionId: 'content' });
    expect(useProjectStore.getState().past).toHaveLength(1);

    useProjectStore.getState().undo();

    const [source, target] = useConfigStore.getState().pages;
    expect('sections' in source ? source.sections.main.map((w) => w.id) : []).toEqual(['comp-1']);
    expect('sections' in target ? target.sections.content : null).toEqual([]);
  });

  it('deletes a page group along with its child pages', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          children: [
            {
              id: 'page-2',
              type: 'page',
              title: 'Page 2',
              sections: { main: [] },
            },
          ],
        },
      ],
      loadedPageIds: new Set(['page-2']),
      dirtyPageIds: new Set(['page-2']),
    });

    useConfigStore.getState().deletePageGroup('group-1');

    expect(useConfigStore.getState().pages.map((node) => node.id)).toEqual([]);
    expect(useConfigStore.getState().loadedPageIds.has('page-2')).toBe(false);
    expect(useConfigStore.getState().dirtyPageIds.has('page-2')).toBe(false);
  });

  it('moves a child between sections via setPageSections', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page-hf',
          type: 'page',
          title: 'HF',
          showHeader: true,
          showFooter: true,
          sections: {
            header: [],
            content: [
              { id: 'w1', type: 'Button', name: 'B1', properties: {} },
              { id: 'w2', type: 'Button', name: 'B2', properties: {} },
            ],
            footer: [],
          },
        },
      ],
      loadedPageIds: new Set(['page-hf']),
      dirtyPageIds: new Set(),
    });

    useConfigStore.getState().setPageSections('page-hf', {
      header: [{ id: 'w1', type: 'Button', name: 'B1', properties: {} }],
      content: [{ id: 'w2', type: 'Button', name: 'B2', properties: {} }],
      footer: [],
    });

    const page = useConfigStore.getState().pages[0] as {
      sections: Record<string, { id: string }[]>;
    };
    expect(page.sections.header.map((c) => c.id)).toEqual(['w1']);
    expect(page.sections.content.map((c) => c.id)).toEqual(['w2']);
    expect(page.sections.footer).toEqual([]);
    expect(useConfigStore.getState().dirtyPageIds.has('page-hf')).toBe(true);
  });

  describe('page-group header & footer', () => {
    beforeEach(() => {
      useConfigStore.setState({
        pages: [
          {
            id: 'group-1',
            type: 'page-group',
            title: 'Group',
            children: [{ id: 'tab-1', type: 'page', title: 'Tab 1', sections: { main: [] } }],
          },
        ],
        header: [],
        footer: [],
        dialogs: [],
        loaded: true,
        loadedPageIds: new Set(['tab-1']),
        dirtyPageIds: new Set(),
      });
    });

    it('appends a widget to the group header via addComponentToPageGroupArea', () => {
      useConfigStore.getState().addComponentToPageGroupArea('group-1', 'header', {
        id: 'hdr-1',
        type: 'Label',
        name: 'Banner',
        properties: {},
      });

      const group = useConfigStore.getState().pages[0];
      expect(group.type).toBe('page-group');
      if (group.type !== 'page-group') return;
      expect(group.header?.map((w) => w.id)).toEqual(['hdr-1']);
      expect(group.footer ?? []).toEqual([]);
    });

    it('removes a widget from the group footer via deleteComponent', () => {
      useConfigStore.setState((s) => ({
        pages: s.pages.map((node) =>
          node.id === 'group-1' && node.type === 'page-group'
            ? {
                ...node,
                footer: [{ id: 'ftr-1', type: 'Label', name: 'Foot', properties: {} }],
              }
            : node,
        ),
      }));

      useConfigStore.getState().deleteComponent('ftr-1');

      const group = useConfigStore.getState().pages[0];
      if (group.type !== 'page-group') throw new Error('expected page group');
      expect(group.footer ?? []).toEqual([]);
    });

    it('updates a widget inside the group header via updateComponent', () => {
      useConfigStore.setState((s) => ({
        pages: s.pages.map((node) =>
          node.id === 'group-1' && node.type === 'page-group'
            ? {
                ...node,
                header: [{ id: 'hdr-1', type: 'Label', name: 'Old', properties: { text: 'Old' } }],
              }
            : node,
        ),
      }));

      useConfigStore.getState().updateComponent('hdr-1', {
        properties: { text: 'New' },
      });

      const group = useConfigStore.getState().pages[0];
      if (group.type !== 'page-group') throw new Error('expected page group');
      expect(group.header?.[0].properties).toEqual({ text: 'New' });
    });
  });

  describe('setPages — persisted page normalization', () => {
    it('normalizes raw wire-shaped pages through the aggregate entry point', () => {
      useConfigStore.getState().setPages([
        {
          id: 'raw-page',
          title: 'Raw Page',
          sections: { content: [{ id: 'w1', type: 'Button' }] },
        },
      ] as never);

      expect(useConfigStore.getState().pages).toEqual([
        {
          id: 'raw-page',
          title: 'Raw Page',
          icon: undefined,
          type: 'page',
          sections: { content: [{ id: 'w1', type: 'Button' }] },
        },
      ]);
    });

    it('drops entries that fail the single-node contract (no id or title) instead of throwing', () => {
      useConfigStore
        .getState()
        .setPages([
          { id: 'ok', title: 'OK' },
          { title: 'Missing id' },
          { id: 'missing-title' },
          null,
        ] as never);

      expect(useConfigStore.getState().pages.map((p) => p.id)).toEqual(['ok']);
    });

    it('defaults a page with no sections to an empty content section', () => {
      useConfigStore.getState().setPages([{ id: 'p1', title: 'P1' }] as never);

      const page = useConfigStore.getState().pages[0];
      expect(page.type).toBe('page');
      if (page.type === 'page') expect(page.sections).toEqual({ content: [] });
    });

    it('marks pages that already arrive with content as loaded and dirty (e.g. undo/redo snapshots)', () => {
      useConfigStore.getState().setPages([
        {
          id: 'hydrated',
          title: 'Hydrated',
          sections: { content: [{ id: 'w1', type: 'Button' }] },
        },
        { id: 'empty', title: 'Empty', sections: { content: [] } },
      ] as never);

      const state = useConfigStore.getState();
      expect(state.loadedPageIds.has('hydrated')).toBe(true);
      expect(state.loadedPageIds.has('empty')).toBe(false);
      expect(state.dirtyPageIds).toEqual(new Set(['hydrated']));
    });

    it('normalizes children nested inside a page-group through the same aggregate call', () => {
      useConfigStore.getState().setPages([
        {
          id: 'group-1',
          title: 'Group',
          type: 'page-group',
          children: [{ id: 'child-1', title: 'Child' }, { bad: 'entry' }],
        },
      ] as never);

      const group = useConfigStore.getState().pages[0];
      if (group.type !== 'page-group') throw new Error('expected page group');
      expect(group.children).toHaveLength(1);
      expect(group.children[0].id).toBe('child-1');
    });
  });
});
