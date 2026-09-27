import { render, screen } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import WidgetTree from './index';

const SECTIONS = [EDITOR_NODE_IDS.PAGES, EDITOR_NODE_IDS.DIALOGS];

function setup() {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useConfigStore.setState({
    // `loaded: false` keeps the tree's one-shot "collapse everything" effect from
    // running, so the fixture renders expanded.
    loaded: false,
    pages: [],
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
    treeOpenSectionIds: SECTIONS,
  });
  return render(<WidgetTree />);
}

/** A node in this section is called a dialog, not a "page that opens as a
 *  dialog" — the wording inside it names the thing the operator gets, the same
 *  way the Pages section names a page. */
describe('the Dialogs section', () => {
  it('asks an empty section for a dialog, not for a page', () => {
    setup();

    const empty = screen.getByText(/no dialogs/i);
    expect(empty.textContent).toBe('No dialogs — use + to add one');
  });

  it('names dialogs, not pages, on its add control', () => {
    setup();

    const add = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title') === 'Add a dialog or dialog group');
    expect(add).toBeDefined();
  });
});
