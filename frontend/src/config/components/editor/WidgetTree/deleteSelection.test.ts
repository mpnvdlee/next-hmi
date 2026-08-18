import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import { deleteWidgetsKeepingSelection } from './deleteSelection';

function setup(selectedIds: string[]) {
  useConfigStore.setState({
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'One',
        sections: {
          content: [
            { id: 'a', type: 'Button', name: 'a' },
            {
              id: 'box',
              type: 'Container',
              name: 'box',
              children: [{ id: 'inner', type: 'Button', name: 'inner' }],
            },
          ],
        },
      },
    ],
    header: [],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [],
    loadedPageIds: new Set(['page-1']),
    dirtyPageIds: new Set(),
  });
  useEditorDomainStore.setState({
    selectedId: selectedIds[selectedIds.length - 1] ?? null,
    selectedIds,
    selectionAnchorId: null,
  });
}

const selection = () => useEditorDomainStore.getState().selectedIds;

describe('deleteWidgetsKeepingSelection', () => {
  it('drops a selected widget that left as a descendant of a deleted container', () => {
    setup(['box', 'inner']);

    deleteWidgetsKeepingSelection(['box']);

    expect(selection()).toEqual([]);
  });

  it('keeps a selected row that was never a widget', () => {
    // Section and shell sentinel rows are not in the tree, so "gone from the tree"
    // cannot be the test for whether the delete took them.
    setup([EDITOR_NODE_IDS.PAGES, 'a']);

    deleteWidgetsKeepingSelection(['a']);

    expect(selection()).toEqual([EDITOR_NODE_IDS.PAGES]);
  });

  it('leaves the selection alone when the delete took none of it', () => {
    setup(['inner']);
    const before = selection();

    deleteWidgetsKeepingSelection(['a']);

    expect(selection()).toBe(before);
  });
});
