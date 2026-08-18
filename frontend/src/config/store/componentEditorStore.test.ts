import { useComponentEditorStore } from './componentEditorStore';

function resetStore() {
  useComponentEditorStore.setState({
    activeComponentId: null,
    selectedId: null,
    selectedIds: [],
    selectionAnchorId: null,
    openTabIds: [],
    previewTabId: null,
    collapsedIds: new Set(),
  });
}

describe('componentEditorStore tabs', () => {
  beforeEach(resetStore);

  it('closes several pinned and temporary tabs in one update', () => {
    const store = useComponentEditorStore.getState();
    store.openTab('component-a');
    store.openTab('component-b');
    store.previewComponent('component-c');

    store.closeTabs(['component-a', 'component-c']);

    expect(useComponentEditorStore.getState()).toMatchObject({
      openTabIds: ['component-b'],
      previewTabId: null,
      activeComponentId: 'component-b',
      selectedId: 'component-b',
      selectedIds: ['component-b'],
    });
  });

  it('keeps the active component selected when closing all other tabs', () => {
    const store = useComponentEditorStore.getState();
    store.openTab('component-a');
    store.openTab('component-b');
    store.previewComponent('component-c');
    store.setActiveTab('component-b');

    store.closeTabs(['component-a', 'component-c']);

    expect(useComponentEditorStore.getState()).toMatchObject({
      openTabIds: ['component-b'],
      previewTabId: null,
      activeComponentId: 'component-b',
      selectedId: 'component-b',
    });
  });
});

describe('componentEditorStore selection', () => {
  beforeEach(() => {
    resetStore();
    useComponentEditorStore.getState().previewComponent('component-a');
  });

  it('leaves a tab action holding exactly one selected id', () => {
    useComponentEditorStore.getState().setSelectedIds(['w1', 'w2']);
    useComponentEditorStore.getState().openTab('component-b');

    expect(useComponentEditorStore.getState()).toMatchObject({
      selectedId: 'component-b',
      selectedIds: ['component-b'],
      selectionAnchorId: 'component-b',
    });
  });

  it('adds and removes widgets, promoting the previous lead', () => {
    const store = () => useComponentEditorStore.getState();
    store().setSelectedId('w1');
    store().toggleSelectedId('w2');
    expect(store()).toMatchObject({ selectedIds: ['w1', 'w2'], selectedId: 'w2' });

    store().toggleSelectedId('w2');
    expect(store()).toMatchObject({ selectedIds: ['w1'], selectedId: 'w1' });
  });

  it('replaces the set rather than letting the definition root join it', () => {
    const store = () => useComponentEditorStore.getState();
    store().setSelectedIds(['w1', 'w2']);

    store().toggleSelectedId('component-a');
    expect(store()).toMatchObject({ selectedIds: ['component-a'], selectedId: 'component-a' });

    store().toggleSelectedId('w1');
    expect(store()).toMatchObject({ selectedIds: ['w1'], selectedId: 'w1' });
  });

  it('clears the anchor when the selection empties', () => {
    const store = () => useComponentEditorStore.getState();
    store().setSelectedId('w1');
    store().toggleSelectedId('w1');

    expect(store()).toMatchObject({ selectedIds: [], selectedId: null, selectionAnchorId: null });
  });
});
