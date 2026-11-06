import { fireEvent, render, screen } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import WidgetTree from './index';

function setup() {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useConfigStore.setState({
    // `loaded: false` keeps the tree's one-shot "collapse everything" effect from
    // running, so the fixture renders expanded.
    loaded: false,
    pages: [
      {
        id: 'group-1',
        type: 'page-group',
        title: 'Operate',
        children: [
          { id: 'page-1', type: 'page', title: 'Dashboard', sections: { content: [] } },
          { id: 'page-2', type: 'page', title: 'Line', sections: { content: [] } },
        ],
      },
    ],
    loadedPageIds: new Set<string>(),
    header: [],
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
    treeOpenSectionIds: [EDITOR_NODE_IDS.PAGES],
    openTabIds: [],
    previewTabId: null,
    activeTabId: null,
  });
  return render(<WidgetTree />);
}

const row = (label: string) => screen.getByText(label).closest('.cfg-tree-item')!;

describe('double-clicking a tree row pins a tab', () => {
  it('pins the page itself', () => {
    setup();
    fireEvent.doubleClick(row('Line'));
    expect(useEditorDomainStore.getState().openTabIds).toEqual(['page-2']);
  });

  it('pins the first page of a page group, the one its click previews', () => {
    setup();
    fireEvent.doubleClick(row('Operate'));
    expect(useEditorDomainStore.getState().openTabIds).toEqual(['page-1']);
  });
});
