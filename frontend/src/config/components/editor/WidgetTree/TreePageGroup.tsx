import { useMemo } from 'react';
import { FolderSimple } from '@phosphor-icons/react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { PageGroupConfig } from '@shared/types/config';
import { TreeDiagnosticDot, TreeRenameInput } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import { useIsCut } from './cutState';
import { useDropIndicator } from './useDropIndicator';
import {
  containsSeverityTitle,
  pageGroupSeverity,
  useArtifactSeverities,
} from '@config/hooks/useProjectDiagnostics';
import { isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import type { CSSWithVars, NodeKind } from './types';
import TreePage from './TreePage';
import PageGroupSectionFolder from './PageGroupSectionFolder';
import { TreeSearchHighlight } from './TreeSearchHighlight';

interface TreePageGroupProps {
  group: PageGroupConfig;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
  editingPageId: string | null;
  editingTitle: string;
  onEditChange: (value: string) => void;
  onEditCommit: (id: string) => void;
  depth?: number;
}

export default function TreePageGroup({
  group,
  collapsed,
  onToggle,
  onCtxMenu,
  editingPageId,
  editingTitle,
  onEditChange,
  onEditCommit,
  depth = 1,
}: TreePageGroupProps) {
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: group.id,
  });

  const isCollapsed = collapsed.has(group.id);
  const isSelected = selectedId === group.id;
  const isCut = useIsCut(group.id);
  const drop = useDropIndicator(group.id);

  const artifactSeverities = useArtifactSeverities();
  const severity = useMemo(
    () => pageGroupSeverity(group, artifactSeverities),
    [group, artifactSeverities],
  );

  const rowStyle: CSSWithVars = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    '--dragging-opacity': isDragging ? '0.4' : '1',
  };

  return (
    <div style={rowStyle} className="editor-tree-row editor-tree-page">
      <TreeRow
        rowRef={setNodeRef}
        variant="page"
        depth={depth}
        selected={isSelected}
        cut={isCut}
        dropTarget={drop.into}
        dropEdge={drop.edge}
        toggle={{ open: !isCollapsed, onClick: () => onToggle(group.id) }}
        icon={
          <span className="cfg-tree-item__icon">
            <FolderSimple size={14} weight="regular" />
          </span>
        }
        label={
          <TreeRenameInput
            id={group.id}
            editingId={editingPageId}
            draft={editingTitle}
            onChange={onEditChange}
            onCommit={onEditCommit}
            label={<TreeSearchHighlight text={resolvePageTitle(group.title)} />}
          />
        }
        onSelect={() => useEditorDomainStore.getState().setSelected(group.id, 'pages')}
        onContextMenu={(event) => {
          event.preventDefault();
          onCtxMenu(event, group.id, 'page-group');
        }}
      >
        {severity && (
          <TreeDiagnosticDot severity={severity} title={containsSeverityTitle(severity)} />
        )}
        <span className="cfg-tree-item__handle" {...attributes} {...listeners}>
          ⠿
        </span>
      </TreeRow>

      {!isCollapsed && (
        <>
          <PageGroupSectionFolder
            groupId={group.id}
            area="header"
            label="Header"
            depth={depth + 1}
            widgets={group.header ?? []}
            collapsed={collapsed}
            onToggle={onToggle}
            onCtxMenu={onCtxMenu}
          />
          <SortableContext
            items={group.children.map((page) => page.id)}
            strategy={verticalListSortingStrategy}
          >
            {group.children.length === 0 ? (
              <div className="cfg-tree-section-empty">No pages yet — right-click to add one</div>
            ) : (
              group.children.map((child) =>
                isPageGroup(child) ? (
                  <TreePageGroup
                    key={child.id}
                    group={child}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    onCtxMenu={onCtxMenu}
                    editingPageId={editingPageId}
                    editingTitle={editingTitle}
                    onEditChange={onEditChange}
                    onEditCommit={onEditCommit}
                    depth={depth + 1}
                  />
                ) : (
                  <TreePage
                    key={child.id}
                    page={child}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    onCtxMenu={onCtxMenu}
                    editingPageId={editingPageId}
                    editingTitle={editingTitle}
                    onEditChange={onEditChange}
                    onEditCommit={onEditCommit}
                    depth={depth + 1}
                  />
                ),
              )
            )}
          </SortableContext>
          <PageGroupSectionFolder
            groupId={group.id}
            area="footer"
            label="Footer"
            depth={depth + 1}
            widgets={group.footer ?? []}
            collapsed={collapsed}
            onToggle={onToggle}
            onCtxMenu={onCtxMenu}
          />
        </>
      )}
    </div>
  );
}
