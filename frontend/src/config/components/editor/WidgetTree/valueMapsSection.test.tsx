import { fireEvent, render, screen } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import { EDITOR_NODE_IDS, makeValueMapNodeId } from '@shared/constants/editorSentinels';
import WidgetTree from './index';

function setup() {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useConfigStore.setState({
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
    valueMaps: [{ id: 'state', type: 'Color', cases: [{ when: 1, then: '#22aa44' }] }],
  });
  useEditorDomainStore.setState({
    selectedId: null,
    selectedIds: [],
    treeCollapsedIds: [],
    treeOpenSectionIds: [EDITOR_NODE_IDS.VALUE_MAPS],
  });
  return render(<WidgetTree />);
}

const ids = () => useConfigStore.getState().valueMaps.map((m) => m.id);
const menu = (row: string, item: string) => {
  fireEvent.contextMenu(screen.getByText(row));
  fireEvent.click(screen.getByRole('button', { name: item }));
};

describe('the Value Maps context menu', () => {
  it('adds a map from the section', () => {
    setup();
    menu('Value Maps', 'Add Value Map');
    expect(ids()).toEqual(['state', 'map-2']);
    expect(useEditorDomainStore.getState().selectedId).toBe(makeValueMapNodeId('map-2'));
  });

  it('duplicates a map right after it, then deletes one', () => {
    setup();
    menu('state', 'Duplicate');
    expect(ids()).toEqual(['state', 'state-copy']);
    expect(useConfigStore.getState().valueMaps[1].cases).toEqual([{ when: 1, then: '#22aa44' }]);

    menu('state', 'Delete Value Map');
    expect(ids()).toEqual(['state-copy']);
  });

  it('renames a map inline in the tree', async () => {
    setup();
    menu('state', 'Rename');
    const input = screen.getByDisplayValue('state');
    fireEvent.change(input, { target: { value: 'machine-state' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('machine-state')).toBeInTheDocument();
    expect(ids()).toEqual(['machine-state']);
  });
});
