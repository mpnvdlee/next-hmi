import './style.css';
import { type ReactNode, useCallback, useMemo } from 'react';
import { Browsers, File, FolderSimple, Rows, SidebarSimple } from '@phosphor-icons/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { findPageNodeById, isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import { EDITOR_NODE_IDS, SHELL_AREA_LABELS } from '@shared/constants/editorSentinels';
import CloseButton from '@shared/components/CloseButton';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useTabStrip, scrollTabsWithWheel } from '@config/hooks/useTabStrip';
import TabCloseContextMenu from './TabCloseContextMenu';

const ICON_SIZE = 14;

const SHELL_LABELS: Record<string, { label: string; icon: ReactNode }> = {
  [EDITOR_NODE_IDS.HEADER]: {
    label: SHELL_AREA_LABELS[EDITOR_NODE_IDS.HEADER],
    icon: <Rows size={ICON_SIZE} weight="regular" />,
  },
  [EDITOR_NODE_IDS.FOOTER]: {
    label: SHELL_AREA_LABELS[EDITOR_NODE_IDS.FOOTER],
    icon: <Rows size={ICON_SIZE} weight="regular" style={{ transform: 'scaleY(-1)' }} />,
  },
  [EDITOR_NODE_IDS.LEFT_SIDEBAR]: {
    label: SHELL_AREA_LABELS[EDITOR_NODE_IDS.LEFT_SIDEBAR],
    icon: <SidebarSimple size={ICON_SIZE} weight="regular" />,
  },
  [EDITOR_NODE_IDS.RIGHT_SIDEBAR]: {
    label: SHELL_AREA_LABELS[EDITOR_NODE_IDS.RIGHT_SIDEBAR],
    icon: <SidebarSimple size={ICON_SIZE} weight="regular" style={{ transform: 'scaleX(-1)' }} />,
  },
};

function resolveTabInfo(
  tabId: string,
  pages: ReturnType<typeof useConfigStore.getState>['pages'],
  dialogs: ReturnType<typeof useConfigStore.getState>['dialogs'],
): { label: string; icon: ReactNode } {
  const shell = SHELL_LABELS[tabId];
  if (shell) return shell;

  const dialog = dialogs.find((d) => d.id === tabId);
  if (dialog) return { label: dialog.title, icon: <Browsers size={ICON_SIZE} weight="regular" /> };

  const page = findPageNodeById(pages, tabId);
  if (page) {
    const icon = isPageGroup(page) ? (
      <FolderSimple size={ICON_SIZE} weight="regular" />
    ) : (
      <File size={ICON_SIZE} weight="regular" />
    );
    return { label: resolvePageTitle(page.title), icon };
  }

  return { label: tabId, icon: null };
}

function TabButton({
  tabId,
  isActive,
  isPreview,
  label,
  icon,
  onOpenContextMenu,
}: {
  tabId: string;
  isActive: boolean;
  isPreview: boolean;
  label: string;
  icon: ReactNode;
  onOpenContextMenu: (event: React.MouseEvent, tabId: string) => void;
}) {
  const closeTab = useEditorDomainStore((s) => s.closeTab);
  const setActiveTab = useEditorDomainStore((s) => s.setActiveTab);
  const openTab = useEditorDomainStore((s) => s.openTab);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeTab(tabId);
    },
    [closeTab, tabId],
  );

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tabId);
      }
    },
    [closeTab, tabId],
  );

  return (
    <div
      role="tab"
      className={`editor-tabbar__tab${isActive ? ' editor-tabbar__tab--active' : ''}${
        isPreview ? ' editor-tabbar__tab--preview' : ''
      }`}
      onClick={() => setActiveTab(tabId)}
      onDoubleClick={isPreview ? () => openTab(tabId) : undefined}
      onMouseDown={handleMiddleClick}
      onContextMenu={(event) => onOpenContextMenu(event, tabId)}
      title={label}
    >
      <span className="editor-tabbar__tab-icon">{icon}</span>
      <span className="editor-tabbar__tab-label">{label}</span>
      <CloseButton
        tone="config"
        className="editor-tabbar__tab-close"
        tabIndex={-1}
        onClick={handleClose}
        title="Close tab"
        label={`Close ${label}`}
      />
    </div>
  );
}

function OverflowItem({
  isActive,
  label,
  icon,
  onSelect,
}: {
  isActive: boolean;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`editor-tabbar__overflow-item${isActive ? ' editor-tabbar__overflow-item--active' : ''}`}
      onClick={onSelect}
    >
      <span className="editor-tabbar__tab-icon">{icon}</span>
      {label}
    </button>
  );
}

export default function TabBar() {
  const openTabIds = useEditorDomainStore((s) => s.openTabIds);
  const previewTabId = useEditorDomainStore((s) => s.previewTabId);
  const activeTabId = useEditorDomainStore((s) => s.activeTabId);
  const setActiveTab = useEditorDomainStore((s) => s.setActiveTab);
  const closeTabs = useEditorDomainStore((s) => s.closeTabs);
  const pages = useConfigStore((s) => s.pages);
  const dialogs = useConfigStore((s) => s.dialogs);

  const tabMenu = useContextMenu<{ tabId: string }>();

  const getSnapshot = useCallback(() => {
    const s = useEditorDomainStore.getState();
    return { openTabIds: s.openTabIds, previewTabId: s.previewTabId, activeTabId: s.activeTabId };
  }, []);

  const {
    tabIds,
    scrollRef,
    dropdownRef,
    overflows,
    dropdownOpen,
    setDropdownOpen,
    handleDropdownSelect,
  } = useTabStrip({ openTabIds, previewTabId, getSnapshot, setActiveTab });

  const tabInfoMap = useMemo(() => {
    const map = new Map<string, { label: string; icon: ReactNode }>();
    for (const tabId of tabIds) {
      map.set(tabId, resolveTabInfo(tabId, pages, dialogs));
    }
    return map;
  }, [tabIds, pages, dialogs]);

  if (tabIds.length === 0) return null;

  const previewInfo = previewTabId ? tabInfoMap.get(previewTabId) : undefined;

  return (
    <div className="editor-tabbar">
      <div ref={scrollRef} className="editor-tabbar__scroll" onWheel={scrollTabsWithWheel}>
        {openTabIds.map((id) => {
          const info = tabInfoMap.get(id);
          return (
            <TabButton
              key={id}
              tabId={id}
              isActive={id === activeTabId}
              isPreview={false}
              label={info?.label ?? id}
              icon={info?.icon ?? null}
              onOpenContextMenu={(event, tabId) => tabMenu.open(event, { tabId })}
            />
          );
        })}
        {previewTabId && !openTabIds.includes(previewTabId) && (
          <TabButton
            tabId={previewTabId}
            isActive={previewTabId === activeTabId}
            isPreview
            label={previewInfo?.label ?? previewTabId}
            icon={previewInfo?.icon ?? null}
            onOpenContextMenu={(event, tabId) => tabMenu.open(event, { tabId })}
          />
        )}
      </div>
      {overflows && (
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="editor-tabbar__overflow-btn"
            onClick={() => setDropdownOpen((v) => !v)}
            title="All open tabs"
          >
            ▾
          </button>
          {dropdownOpen && (
            <div className="editor-tabbar__overflow-dropdown">
              {tabIds.map((id) => {
                const info = tabInfoMap.get(id);
                return (
                  <OverflowItem
                    key={id}
                    isActive={id === activeTabId}
                    label={info?.label ?? id}
                    icon={info?.icon ?? null}
                    onSelect={() => handleDropdownSelect(id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
      <TabCloseContextMenu tabMenu={tabMenu} tabIds={tabIds} closeTabs={closeTabs} />
    </div>
  );
}
