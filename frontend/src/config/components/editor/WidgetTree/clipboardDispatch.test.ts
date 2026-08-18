import { useConfigStore } from '@shared/store/configStore';
import { useProjectStore } from '@shared/store/projectStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import {
  clipboardNodeIds,
  dispatchPaste,
  projectFromStore,
  resolveCopyEntry,
} from './clipboardDispatch';
import { clearCut, pendingCut, setCut } from './cutState';
import type { PageConfig, PageGroupConfig, WidgetConfig } from '@shared/types/config';
import type { ClipboardMulti, ClipboardNode } from './clipboardOps';

const widget = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
  id,
  type: children ? 'Container' : 'Button',
  name: id,
  ...(children ? { children } : {}),
});

function seed() {
  useProjectStore.setState({ past: [], future: [], dirty: false });
  clearCut();
  useConfigStore.setState({
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'Page 1',
        sections: { content: [widget('btn'), widget('box', [])] },
      },
      { id: 'page-2', type: 'page', title: 'Page 2', sections: { content: [] } },
    ],
    header: [],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    loaded: true,
    dirtyPageIds: new Set(),
  });
}

const contentOf = (pageId: string) => {
  const page = useConfigStore.getState().pages.find((p) => p.id === pageId);
  return page && 'sections' in page ? page.sections.content : [];
};

const clipboardWidget = (id: string): ClipboardNode => {
  const found = contentOf('page-1').find((w) => w.id === id);
  return { kind: 'widget', node: structuredClone(found!) };
};

describe('dispatchPaste', () => {
  beforeEach(seed);

  it('clones when nothing was cut', () => {
    dispatchPaste(projectFromStore(), clipboardWidget('btn'), 'page-2', 'page');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['btn', 'box']);
    const pasted = contentOf('page-2');
    expect(pasted).toHaveLength(1);
    expect(pasted[0].id).not.toBe('btn');
  });

  it('moves the node, id intact, when it was cut', () => {
    const entry = clipboardWidget('btn');
    setCut(['btn'], 'widget');

    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['box']);
    expect(contentOf('page-2').map((w) => w.id)).toEqual(['btn']);
    expect(pendingCut()).toBeNull();
  });

  it('records the move as one undo step', () => {
    const entry = clipboardWidget('btn');
    setCut(['btn'], 'widget');
    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    expect(useProjectStore.getState().past).toHaveLength(1);
    useProjectStore.getState().undo();

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['btn', 'box']);
    expect(contentOf('page-2')).toEqual([]);
  });

  it('clones a second paste of the same node — a cut moves once', () => {
    const entry = clipboardWidget('btn');
    setCut(['btn'], 'widget');
    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');
    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    const pasted = contentOf('page-2');
    expect(pasted).toHaveLength(2);
    expect(pasted[1].id).not.toBe('btn');
  });

  it('refuses to move a container into its own subtree, leaving the tree intact', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page 1',
          sections: { content: [widget('box', [widget('inner', [])])] },
        },
      ],
    });
    const entry = clipboardWidget('box');
    setCut(['box'], 'widget');

    dispatchPaste(projectFromStore(), entry, 'inner', 'container');

    const content = contentOf('page-1');
    expect(content.map((w) => w.id)).toEqual(['box']);
    // Rejected outright — no clone of the cut node landed inside it either.
    expect(content[0].children?.map((w) => w.id)).toEqual(['inner']);
    expect(pendingCut()?.nodeIds).toEqual(new Set(['box']));
  });

  it('refuses to move a widget onto its own row', () => {
    const entry = clipboardWidget('box');
    setCut(['box'], 'widget');

    dispatchPaste(projectFromStore(), entry, 'box', 'container');

    const content = contentOf('page-1');
    expect(content.map((w) => w.id)).toEqual(['btn', 'box']);
    // No clone of itself landed inside it, and the cut is still available.
    expect(content[1].children ?? []).toEqual([]);
    expect(pendingCut()?.nodeIds).toEqual(new Set(['box']));
  });

  it('refuses to move a page group into a group under it, keeping its pages', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'outer',
          type: 'page-group',
          title: 'Outer',
          children: [
            {
              id: 'inner',
              type: 'page-group',
              title: 'Inner',
              children: [
                { id: 'page-3', type: 'page', title: 'Page 3', sections: { content: [] } },
              ],
            },
          ],
        },
      ],
    });
    const outer = useConfigStore.getState().pages[0] as PageGroupConfig;
    const entry: ClipboardNode = { kind: 'page-group', node: structuredClone(outer) };
    setCut(['outer'], 'page-group');

    dispatchPaste(projectFromStore(), entry, 'inner', 'page-group');

    const survivor = useConfigStore.getState().pages.find((p) => p.id === 'outer');
    expect(survivor).toBeDefined();
    expect(
      survivor && survivor.type === 'page-group' ? survivor.children.map((c) => c.id) : [],
    ).toEqual(['inner']);
    const inner = survivor?.type === 'page-group' ? survivor.children[0] : null;
    // Rejected, not cloned into its own descendant.
    expect(inner?.type === 'page-group' ? inner.children.map((c) => c.id) : []).toEqual(['page-3']);
    expect(pendingCut()?.nodeIds).toEqual(new Set(['outer']));
  });

  it('keeps a moved group of pages loaded and dirty, so their content still saves', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-a',
          type: 'page-group',
          title: 'A',
          children: [{ id: 'page-3', type: 'page', title: 'Page 3', sections: { content: [] } }],
        },
        { id: 'group-b', type: 'page-group', title: 'B', children: [] },
      ],
      loadedPageIds: new Set(['page-3']),
      dirtyPageIds: new Set(['page-3']),
    });
    const group = useConfigStore.getState().pages[0] as PageGroupConfig;
    setCut(['group-a'], 'page-group');

    dispatchPaste(
      projectFromStore(),
      { kind: 'page-group', node: structuredClone(group) },
      'group-b',
      'page-group',
    );

    const state = useConfigStore.getState();
    expect(state.pages.map((p) => p.id)).toEqual(['group-b']);
    expect([...state.loadedPageIds]).toEqual(['page-3']);
    expect([...state.dirtyPageIds]).toEqual(['page-3']);
  });
});

describe('resolveCopyEntry', () => {
  beforeEach(() => {
    seed();
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page 1',
          sections: { content: [widget('box', [widget('btn')]), widget('sibling')] },
        },
      ],
    });
    useEditorDomainStore.setState({ selectedId: null, selectedIds: [], selectionAnchorId: null });
  });

  const select = (...ids: string[]) =>
    useEditorDomainStore.setState({ selectedId: ids[ids.length - 1] ?? null, selectedIds: ids });

  it('acts on the container the selection collapsed onto, not the row clicked', () => {
    select('box', 'btn');

    const entry = resolveCopyEntry(projectFromStore(), 'btn', 'leaf');

    // What delete and duplicate would take, so cut records the same ids.
    expect(entry && clipboardNodeIds(entry)).toEqual(['box']);
  });

  it('acts on the clicked row alone when it is outside the selection', () => {
    select('box', 'btn');

    const entry = resolveCopyEntry(projectFromStore(), 'sibling', 'leaf');

    expect(entry && clipboardNodeIds(entry)).toEqual(['sibling']);
  });

  it('takes the whole selection when the clicked row is part of it', () => {
    select('box', 'sibling');

    const entry = resolveCopyEntry(projectFromStore(), 'sibling', 'leaf');

    expect(entry && clipboardNodeIds(entry)).toEqual(['box', 'sibling']);
  });
});

describe('dispatchPaste of several nodes', () => {
  beforeEach(() => {
    seed();
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page 1',
          sections: { content: [widget('one'), widget('two'), widget('three')] },
        },
        { id: 'page-2', type: 'page', title: 'Page 2', sections: { content: [widget('anchor')] } },
      ],
    });
    useEditorDomainStore.setState({
      selectedId: null,
      selectedIds: [],
      selectionAnchorId: null,
    });
  });

  const multi = (...ids: string[]): ClipboardMulti => ({
    kind: 'multi',
    nodes: ids.map((id) => ({
      kind: 'widget',
      node: structuredClone(contentOf('page-1').find((w) => w.id === id)!),
    })),
  });

  it('clones every node into an appending target, in order', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), 'page-2', 'page');

    const pasted = contentOf('page-2');
    expect(pasted.map((w) => w.name)).toEqual(['anchor', 'one', 'two']);
    expect(pasted.map((w) => w.id)).not.toContain('one');
  });

  it('keeps document order when pasting beside a leaf', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), 'anchor', 'leaf');

    expect(contentOf('page-2').map((w) => w.name)).toEqual(['anchor', 'one', 'two']);
  });

  it('keeps the copied order when pasting a page batch beside a page', () => {
    const page = (id: string, title: string): PageConfig => ({
      id,
      type: 'page',
      title,
      sections: { content: [] },
    });
    const pages: ClipboardMulti = {
      kind: 'multi',
      nodes: [
        { kind: 'page', node: page('a', 'A') },
        { kind: 'page', node: page('b', 'B') },
      ],
    };

    dispatchPaste(projectFromStore(), pages, 'page-1', 'page');

    expect(useConfigStore.getState().pages.map((p) => p.title)).toEqual([
      'Page 1',
      'A',
      'B',
      'Page 2',
    ]);
  });

  it('gives every clone a distinct id', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), 'page-2', 'page');

    const ids = contentOf('page-2').map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('selects everything it pasted', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), 'page-2', 'page');

    const pastedIds = contentOf('page-2')
      .filter((w) => w.id !== 'anchor')
      .map((w) => w.id);
    expect(useEditorDomainStore.getState().selectedIds).toEqual(pastedIds);
  });

  it('moves every node, ids intact, when they were cut', () => {
    const entry = multi('one', 'three');
    setCut(['one', 'three'], 'widget');

    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['two']);
    expect(contentOf('page-2').map((w) => w.id)).toEqual(['anchor', 'one', 'three']);
    expect(pendingCut()).toBeNull();
  });

  it('records a multi move as one undo step', () => {
    const entry = multi('one', 'three');
    setCut(['one', 'three'], 'widget');
    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    expect(useProjectStore.getState().past).toHaveLength(1);
    useProjectStore.getState().undo();

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['one', 'two', 'three']);
  });

  it('records a multi clone as one undo step', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), 'page-2', 'page');

    expect(useProjectStore.getState().past).toHaveLength(1);
    useProjectStore.getState().undo();

    expect(contentOf('page-2').map((w) => w.id)).toEqual(['anchor']);
  });

  it('clones rather than moves when the cut covers only part of the batch', () => {
    const entry = multi('one', 'three');
    setCut(['one'], 'widget');

    dispatchPaste(projectFromStore(), entry, 'page-2', 'page');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['one', 'two', 'three']);
    expect(contentOf('page-2')).toHaveLength(3);
  });

  it('records neither an undo step nor a dirty flag when a clone target refuses', () => {
    dispatchPaste(projectFromStore(), multi('one', 'two'), '__settings__', 'leaf');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['one', 'two', 'three']);
    expect(useProjectStore.getState().past).toEqual([]);
    expect(useProjectStore.getState().dirty).toBe(false);
  });

  it('publishes a fresh structure revision when a refused move puts the tree back', () => {
    const entry = multi('one', 'three');
    setCut(['one', 'three'], 'widget');
    // The row the paste was aimed at is gone by the time the paste runs (another
    // tab, an undo). The pre-check passes against the tree the menu was built
    // from, so the insert only refuses once the removal has already happened.
    const stale = projectFromStore();
    useConfigStore.getState().deleteComponent('anchor');
    const seen: Array<{ rev: number; pages: unknown }> = [];
    const unsubscribe = useConfigStore.subscribe((s) =>
      seen.push({ rev: s.structureRev, pages: s.pages }),
    );

    dispatchPaste(stale, entry, 'anchor', 'leaf');
    unsubscribe();

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['one', 'two', 'three']);
    // No two trees may share a revision: a memo keyed on it would answer for the
    // restored tree out of the cache it filled from the stripped one.
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i += 1) {
      if (seen[i].pages !== seen[i - 1].pages) expect(seen[i].rev).not.toBe(seen[i - 1].rev);
    }
  });

  it('refuses a target that cannot take the nodes, leaving the tree intact', () => {
    const entry = multi('one', 'two');
    setCut(['one', 'two'], 'widget');

    dispatchPaste(projectFromStore(), entry, '__settings__', 'leaf');

    expect(contentOf('page-1').map((w) => w.id)).toEqual(['one', 'two', 'three']);
    expect(pendingCut()?.nodeIds).toEqual(new Set(['one', 'two']));
  });
});
