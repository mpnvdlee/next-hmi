import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { DialogConfig } from '@shared/types/config';
import { TreeDiagnosticDot, TreeRenameInput, TreeRowActionButton } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import { useIsCut } from './cutState';
import { useDropIndicator } from './useDropIndicator';
import { containsSeverityTitle, useArtifactSeverity } from '@config/hooks/useProjectDiagnostics';
import type { NodeKind } from './types';
import AreaWidgetList from './AreaWidgetList';
import { TreeSearchHighlight } from './TreeSearchHighlight';

interface TreeDialogPageProps {
  popup: DialogConfig;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
  editingPageId: string | null;
  editingTitle: string;
  onEditChange: (value: string) => void;
  onEditCommit: (id: string) => void;
}

export default function TreeDialogPage({
  popup,
  collapsed,
  onToggle,
  onCtxMenu,
  editingPageId,
  editingTitle,
  onEditChange,
  onEditCommit,
}: TreeDialogPageProps) {
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const isCollapsed = collapsed.has(popup.id);
  const isSelected = selectedId === popup.id;
  const isCut = useIsCut(popup.id);
  const drop = useDropIndicator(popup.id);
  const severity = useArtifactSeverity('dialog', popup.id);

  return (
    <div className="editor-tree-row editor-tree-page">
      <TreeRow
        variant="page"
        depth={1}
        selected={isSelected}
        cut={isCut}
        dropTarget={drop.into}
        dropEdge={drop.edge}
        toggle={{ open: !isCollapsed, onClick: () => onToggle(popup.id) }}
        icon={<span className="cfg-tree-item__icon">⊞</span>}
        label={
          <TreeRenameInput
            id={popup.id}
            editingId={editingPageId}
            draft={editingTitle}
            onChange={onEditChange}
            onCommit={onEditCommit}
            label={<TreeSearchHighlight text={popup.title} />}
          />
        }
        onSelect={() => {
          const store = useEditorDomainStore.getState();
          store.setSelected(popup.id, 'dialogs');
          store.previewPage(popup.id);
        }}
        onDoubleClick={() => useEditorDomainStore.getState().openTab(popup.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onCtxMenu(event, popup.id, 'dialog-page');
        }}
      >
        {severity && (
          <TreeDiagnosticDot severity={severity} title={containsSeverityTitle(severity)} />
        )}
        <TreeRowActionButton
          title="Delete dialog"
          onClick={(event) => {
            event.stopPropagation();
            useConfigStore.getState().deleteDialog(popup.id);
            if (useEditorDomainStore.getState().selectedId === popup.id) {
              useEditorDomainStore.getState().setSelected(null);
            }
          }}
        >
          ✕
        </TreeRowActionButton>
      </TreeRow>

      {!isCollapsed && (
        <AreaWidgetList
          dropId={popup.id}
          components={popup.widgets}
          collapsed={collapsed}
          onToggle={onToggle}
          onCtxMenu={onCtxMenu}
          depth={2}
        />
      )}
    </div>
  );
}
