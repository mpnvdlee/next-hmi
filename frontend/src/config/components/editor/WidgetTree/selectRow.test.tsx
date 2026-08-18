import { fireEvent, render, screen } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import type { WidgetConfig } from '@shared/types/config';
import WidgetTree from './index';
import { flattenVisibleRows } from './visibleRows';

const widget = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
  id,
  type: children ? 'Container' : 'Button',
  name: id,
  ...(children ? { children } : {}),
});

const SECTIONS = [
  '__header__',
  '__leftSidebar__',
  '__rightSidebar__',
  '__footer__',
  EDITOR_NODE_IDS.PAGES,
  EDITOR_NODE_IDS.DIALOGS,
];

function setup() {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useConfigStore.setState({
    // `loaded: false` keeps the tree's one-shot "collapse everything" effect from
    // running, so the fixture renders expanded.
    loaded: false,
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'One',
        sections: { content: [widget('a'), widget('box', [widget('inner')]), widget('b')] },
      },
    ],
    loadedPageIds: new Set(['page-1']),
    header: [widget('head-btn')],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    shell: {},
    globalEvents: {},
  });
  useEditorDomainStore.setState({
    selectedId: null,
    selectedIds: [],
    selectionAnchorId: null,
    selectedRegion: null,
    selectedParam: null,
    treeCollapsedIds: [],
    treeOpenSectionIds: SECTIONS,
  });
  return render(<WidgetTree />);
}

function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest('.cfg-tree-item');
  if (!el) throw new Error(`no tree row for ${label}`);
  return el as HTMLElement;
}

const selection = () => useEditorDomainStore.getState().selectedIds;

describe('WidgetTree row selection', () => {
  it('replaces the selection on a plain click', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'));

    expect(selection()).toEqual(['b']);
  });

  it('adds and removes widgets on ctrl/cmd-click', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });
    expect(selection()).toEqual(['a', 'b']);

    fireEvent.click(row('b'), { metaKey: true });
    expect(selection()).toEqual(['a']);
  });

  it('collapses a multi-selection when one of its rows is clicked plainly', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.click(row('b'));

    expect(selection()).toEqual(['b']);
  });

  it('extends over the visible rows on shift-click', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { shiftKey: true });

    expect(selection()).toEqual(['a', 'box', 'inner', 'b']);
  });

  it('skips rows that cannot be selected inside a shift range', () => {
    setup();

    fireEvent.click(row('head-btn'));
    fireEvent.click(row('a'), { shiftKey: true });

    // The shell section rows and the Pages/page rows in between are dropped.
    expect(selection()).toEqual(['head-btn', 'a']);
  });

  it('falls back to a plain select when the anchor is not a widget row', () => {
    setup();

    // A page row can never be part of a widget selection, so a range starting there
    // has no meaning — without the guard it sweeps in every widget below it.
    fireEvent.click(row('One'));
    fireEvent.click(row('b'), { shiftKey: true });

    expect(selection()).toEqual(['b']);
    // The failed range still re-anchors, so the next shift-click extends from 'b'.
    fireEvent.click(row('a'), { shiftKey: true });
    expect(selection()).toEqual(['a', 'box', 'inner', 'b']);
  });

  it('starts over when a page row is ctrl-clicked into a widget selection', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.click(row('One'), { ctrlKey: true });

    expect(selection()).toEqual(['page-1']);
  });

  it('marks every selected row, not only the lead', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });

    expect(row('a').className).toContain('cfg-tree-item--selected');
    expect(row('b').className).toContain('cfg-tree-item--selected');
  });

  it('keeps a multi-selection when one of its rows is right-clicked', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('a'));

    expect(selection()).toEqual(['a', 'b']);
  });

  it('drops deleted widgets from the selection, descendants included', () => {
    setup();

    // The lead is a child of the other selected row, so the delete acts on 'box'
    // alone — 'inner' goes with it all the same.
    fireEvent.click(row('box'));
    fireEvent.click(row('inner'), { ctrlKey: true });
    fireEvent.contextMenu(row('inner'));
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.queryByText('inner')).toBeNull();
    expect(selection()).toEqual([]);
  });

  it('re-points the selection when a widget outside it is right-clicked', () => {
    setup();

    fireEvent.click(row('a'));
    fireEvent.click(row('b'), { ctrlKey: true });
    fireEvent.contextMenu(row('inner'));

    expect(selection()).toEqual(['inner']);
  });
});

describe('flattenVisibleRows agreement with the rendered tree', () => {
  it('produces one row per rendered row, at the same depths', () => {
    const { container } = setup();
    const state = useConfigStore.getState();

    const rows = flattenVisibleRows({
      pages: state.pages,
      shell: {
        header: state.header,
        footer: state.footer,
        leftSidebar: state.leftSidebar,
        rightSidebar: state.rightSidebar,
      },
      dialogs: state.dialogs,
      collapsed: new Set<string>(),
      sectionsOpen: new Set(SECTIONS),
      visible: {
        settings: true,
        events: true,
        pages: true,
        dialogs: true,
        hiddenShellRegions: new Set(),
      },
    });

    const rendered = Array.from(container.querySelectorAll('.cfg-tree-item')).map((el) =>
      Number((el as HTMLElement).style.getPropertyValue('--tree-depth') || '0'),
    );

    expect(rendered).toEqual(rows.map((r) => r.depth));
  });
});
