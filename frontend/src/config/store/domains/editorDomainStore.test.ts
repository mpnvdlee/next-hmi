import type { SchemaField } from '@shared/types/widgetSchema';
import { useEditorDomainStore } from './editorDomainStore';

function resetStore() {
  useEditorDomainStore.setState({
    selectedId: null,
    selectedIds: [],
    selectionAnchorId: null,
    selectedRegion: null,
    selectedParam: null,
    openTabIds: [],
    previewTabId: null,
    activeTabId: null,
    previewAreaId: '',
  });
}

describe('editorDomainStore tabs', () => {
  beforeEach(resetStore);

  it('replaces the temporary preview tab when another page is previewed', () => {
    const store = useEditorDomainStore.getState();

    store.previewPage('page-a');
    store.previewPage('page-b');

    expect(useEditorDomainStore.getState()).toMatchObject({
      openTabIds: [],
      previewTabId: 'page-b',
      activeTabId: 'page-b',
      previewAreaId: 'page-b',
    });
  });

  it('pins a preview page without leaving a duplicate temporary tab', () => {
    const store = useEditorDomainStore.getState();

    store.previewPage('page-a');
    store.openTab('page-a');

    expect(useEditorDomainStore.getState()).toMatchObject({
      openTabIds: ['page-a'],
      previewTabId: null,
      activeTabId: 'page-a',
      previewAreaId: 'page-a',
    });
  });

  it('keeps pinned tabs when a different page is temporarily previewed', () => {
    const store = useEditorDomainStore.getState();

    store.openTab('page-a');
    store.previewPage('page-b');
    store.previewPage('page-c');

    expect(useEditorDomainStore.getState()).toMatchObject({
      openTabIds: ['page-a'],
      previewTabId: 'page-c',
      activeTabId: 'page-c',
    });
  });

  it('returns to a neighboring pinned tab when the active preview closes', () => {
    const store = useEditorDomainStore.getState();

    store.openTab('page-a');
    store.previewPage('page-b');
    store.closeTab('page-b');

    expect(useEditorDomainStore.getState()).toMatchObject({
      openTabIds: ['page-a'],
      previewTabId: null,
      activeTabId: 'page-a',
      previewAreaId: 'page-a',
    });
  });
});

describe('editorDomainStore selection', () => {
  const store = () => useEditorDomainStore.getState();
  const param = { path: ['label'], schema: { type: 'String' } as SchemaField };

  beforeEach(resetStore);

  it('keeps the lead as the last selected id', () => {
    store().setSelected('w1');
    store().toggleSelected('w2');
    store().toggleSelected('w3');

    expect(store()).toMatchObject({ selectedIds: ['w1', 'w2', 'w3'], selectedId: 'w3' });
  });

  it('collapses a multi-selection when a row is clicked plainly', () => {
    store().setSelectedMany(['w1', 'w2', 'w3']);
    store().setSelected('w3');

    expect(store()).toMatchObject({ selectedIds: ['w3'], selectedId: 'w3' });
  });

  it('promotes the previous lead when the lead is toggled off', () => {
    store().setSelectedMany(['w1', 'w2']);
    store().toggleSelected('w2');

    expect(store()).toMatchObject({ selectedIds: ['w1'], selectedId: 'w1' });
  });

  it('clears the anchor and the region once the selection empties', () => {
    store().setSelected('w1', 'pages');
    store().toggleSelected('w1');

    expect(store()).toMatchObject({
      selectedIds: [],
      selectedId: null,
      selectionAnchorId: null,
      selectedRegion: null,
    });
  });

  it('anchors on the clicked row so a later range starts there', () => {
    store().setSelected('w1');
    store().toggleSelected('w2');
    expect(store().selectionAnchorId).toBe('w2');

    store().setSelectedMany(['w2', 'w3', 'w4'], null, 'w2');
    expect(store().selectionAnchorId).toBe('w2');
  });

  it('drops duplicates rather than selecting a row twice', () => {
    store().setSelectedMany(['w1', 'w2', 'w1']);

    expect(store().selectedIds).toEqual(['w1', 'w2']);
  });

  it('clears the selected parameter on a real change but not on a true no-op', () => {
    store().setSelected('w1');
    store().setSelectedParam(param);
    store().setSelected('w1');
    expect(store().selectedParam).toBe(param);

    store().setSelected('w2');
    expect(store().selectedParam).toBeNull();
  });

  it('clears the selected parameter when a repeat click collapses a multi-selection', () => {
    store().setSelectedMany(['w1', 'w2']);
    store().setSelectedParam(param);
    store().setSelected('w2');

    expect(store()).toMatchObject({ selectedIds: ['w2'], selectedParam: null });
  });
});
