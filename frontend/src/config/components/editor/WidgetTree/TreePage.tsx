import { useCallback, useEffect, useMemo } from 'react';
import type { JSX } from 'react';
import { File } from '@phosphor-icons/react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import type { WidgetConfig, PageConfig } from '@shared/types/config';
import { getPageChildren } from '@shared/utils/pageContent';
import {
  pageHasExplicitSections,
  pageSectionGroups,
  resolvePageTitle,
} from '@shared/utils/pageTree';
import { TreeDiagnosticDot, TreeRenameInput } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import { useIsCut } from './cutState';
import { useDropIndicator } from './useDropIndicator';
import { containsSeverityTitle, useArtifactSeverity } from '@config/hooks/useProjectDiagnostics';
import {
  makePageSectionId,
  sectionEmptyDropId,
  sectionRowDropId,
} from '@shared/constants/editorSentinels';
import type { CSSWithVars, NodeKind } from './types';
import TreeNode from './TreeNode';
import TreeSection from './TreeSection';
import { TreeSearchHighlight } from './TreeSearchHighlight';

interface TreePageProps {
  page: PageConfig;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
  editingPageId: string | null;
  editingTitle: string;
  onEditChange: (value: string) => void;
  onEditCommit: (pageId: string) => void;
  depth?: number;
}

export default function TreePage({
  page,
  collapsed,
  onToggle,
  onCtxMenu,
  editingPageId,
  editingTitle,
  onEditChange,
  onEditCommit,
  depth = 1,
}: TreePageProps) {
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: page.id,
  });

  const isCollapsed = collapsed.has(page.id);
  const isSelected = selectedId === page.id;
  const isCut = useIsCut(page.id);
  const drop = useDropIndicator(page.id);
  const severity = useArtifactSeverity('page', page.id);

  // Eagerly load page content when the tree node is expanded so the
  // widgets are available even before the preview switches. Pages are leaves
  // now — they never contain other pages — so this is safe for every page
  // that appears at any depth in the tree.
  const loadPageContent = useConfigStore((s) => s.loadPageContent);
  useEffect(() => {
    if (!isCollapsed) loadPageContent(page.id);
  }, [isCollapsed, page.id, loadPageContent]);

  const pageChildren = useMemo(() => getPageChildren(page), [page]);

  const sectionGroups = useMemo(() => {
    if (!pageHasExplicitSections(page)) return null;
    return pageSectionGroups(page).map(({ id, label }) => ({
      id,
      label,
      widgets: page.sections[id] ?? [],
    }));
  }, [page]);

  const renderChild = useCallback(
    (widget: WidgetConfig, childDepth: number) => (
      <TreeNode
        key={widget.id}
        comp={widget}
        collapsed={collapsed}
        onToggle={onToggle}
        onCtxMenu={onCtxMenu}
        depth={childDepth}
      />
    ),
    [collapsed, onToggle, onCtxMenu],
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
        toggle={{ open: !isCollapsed, onClick: () => onToggle(page.id) }}
        icon={
          <span className="cfg-tree-item__icon">
            <File size={14} weight="regular" />
          </span>
        }
        label={
          <TreeRenameInput
            id={page.id}
            editingId={editingPageId}
            draft={editingTitle}
            onChange={onEditChange}
            onCommit={onEditCommit}
            label={<TreeSearchHighlight text={resolvePageTitle(page.title)} />}
          />
        }
        onSelect={() => {
          const store = useEditorDomainStore.getState();
          store.setSelected(page.id, 'pages');
          store.previewPage(page.id);
        }}
        onDoubleClick={() => useEditorDomainStore.getState().openTab(page.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onCtxMenu(event, page.id, 'page');
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
        <SortableContext
          items={pageChildren.map((item) => item.id)}
          strategy={verticalListSortingStrategy}
        >
          {sectionGroups ? (
            sectionGroups.map((section) => (
              <SectionContent
                key={section.id}
                pageId={page.id}
                section={section}
                depth={depth}
                collapsed={collapsed}
                onToggle={onToggle}
                onCtxMenu={onCtxMenu}
                renderChild={renderChild}
              />
            ))
          ) : (
            <>
              {pageChildren.length === 0 && (
                <div className="cfg-tree-section-empty">Empty — right-click to add components</div>
              )}
              {pageChildren.map((child) => renderChild(child, depth + 1))}
            </>
          )}
        </SortableContext>
      )}
    </div>
  );
}

interface SectionContentProps {
  pageId: string;
  section: { id: string; label: string; widgets: WidgetConfig[] };
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onCtxMenu: (event: React.MouseEvent, id: string, kind: NodeKind) => void;
  renderChild: (widget: WidgetConfig, depth: number) => JSX.Element | null;
}

function SectionContent({
  pageId,
  section,
  depth,
  collapsed,
  onToggle,
  onCtxMenu,
  renderChild,
}: SectionContentProps) {
  const sectionKey = makePageSectionId(pageId, section.id);
  return (
    <TreeSection
      label={section.label}
      depth={depth + 1}
      collapsed={collapsed.has(sectionKey)}
      onToggle={() => onToggle(sectionKey)}
      onContextMenu={(event) => onCtxMenu(event, sectionKey, 'page-section')}
      rowDropId={sectionRowDropId(pageId, section.id)}
      emptyDropId={sectionEmptyDropId(pageId, section.id)}
      isEmpty={section.widgets.length === 0}
    >
      {section.widgets.map((widget) => renderChild(widget, depth + 2))}
    </TreeSection>
  );
}
