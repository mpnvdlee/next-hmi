import '@hmi/styles/hmi.css';
import { useEffect } from 'react';
import { useConfig, usePage } from '@shared/hooks/useConfig';
import { useTranslations } from '@shared/hooks/useTranslations';
import { useConfigStore } from '@shared/store/configStore';
import {
  SHELL_REGION_IDS,
  regionForShellSectionId,
  shellSectionIdForRegion,
  type PageConfig,
} from '@shared/types/config';
import { useEditorDomainStore } from '../store/domains/editorDomainStore';
import ConfigLayout from '../components/ui/ConfigLayout';
import WidgetTree from '../components/editor/WidgetTree';
import LivePreview from '../components/editor/LivePreview';
import PreviewEmptyState from '../components/editor/PreviewEmptyState';
import PropertiesPanel from '../components/editor/PropertiesPanel';
import {
  allPageRootNodes,
  findFirstPage,
  findOwningPage,
  findPageNodeById,
  flattenPages,
  isPageGroup,
  treeContains,
} from '@shared/utils/pageTree';

export default function EditorView() {
  useConfig();
  useTranslations();

  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const dialogs = useConfigStore((s) => s.dialogs);
  const selectedId = useEditorDomainStore((s) => s.selectedId);

  const previewAreaId = useEditorDomainStore((s) => s.previewAreaId);

  usePage(previewAreaId || undefined);

  useEffect(() => {
    const editorState = useEditorDomainStore.getState();
    if (editorState.openTabIds.length > 0 || editorState.previewTabId) return;
    const firstPage = findFirstPage(pages);
    if (firstPage) editorState.openTab(firstPage.id);
  }, [pages]);

  useEffect(() => {
    const editorState = useEditorDomainStore.getState();
    const tabIds = editorState.previewTabId
      ? [...editorState.openTabIds, editorState.previewTabId]
      : editorState.openTabIds;
    const pageNodes = allPageRootNodes({ pages, dialogs });
    const stale = tabIds.filter((id) => {
      if (id.startsWith('__') && id.endsWith('__')) return false;
      if (findPageNodeById(pageNodes, id)) return false;
      return true;
    });
    if (stale.length > 0) editorState.closeTabs(stale);
  }, [pages, dialogs]);

  // When selectedId changes, activate the tab containing that node. If its
  // page or shell area is not pinned yet, show it as the temporary tab.
  useEffect(() => {
    if (!selectedId) return;

    const resolveAreaId = (): string | null => {
      if (regionForShellSectionId(selectedId)) return selectedId;

      const shellAreas = { header, footer, leftSidebar, rightSidebar };
      const pageNodes = allPageRootNodes({ pages, dialogs });

      const loadablePages: PageConfig[] = flattenPages(pageNodes);
      const resolveLoadable = (id: string): string | undefined =>
        loadablePages.find((p) => p.id === id)?.id;

      const selectedPageNode = findPageNodeById(pageNodes, selectedId);
      if (selectedPageNode) {
        if (isPageGroup(selectedPageNode)) {
          return findFirstPage(selectedPageNode.children)?.id ?? null;
        }
        return resolveLoadable(selectedId) ?? null;
      }

      const pg = findOwningPage(pageNodes, selectedId);
      if (pg) return resolveLoadable(pg.id) ?? null;

      for (const region of SHELL_REGION_IDS) {
        if (treeContains(shellAreas[region], selectedId)) {
          return shellSectionIdForRegion(region);
        }
      }

      return null;
    };

    const areaId = resolveAreaId();
    const store = useEditorDomainStore.getState();
    if (!areaId || store.activeTabId === areaId) return;
    if (store.openTabIds.includes(areaId) || store.previewTabId === areaId) {
      store.setActiveTab(areaId);
    } else {
      store.previewPage(areaId);
    }
  }, [selectedId, pages, header, footer, leftSidebar, rightSidebar, dialogs]);

  return (
    <ConfigLayout
      storageKey="editor"
      left={<WidgetTree />}
      center={
        <div className="editor-preview">
          {previewAreaId ? (
            <LivePreview pageId={previewAreaId} />
          ) : (
            <PreviewEmptyState message="No page selected." />
          )}
        </div>
      }
      right={<PropertiesPanel />}
    />
  );
}
