/**
 * CompositionTabBar — tab strip for the /config/components preview.
 *
 * Mirrors editor/TabBar's look and interaction (click/close/middle-click/
 * overflow/alt+arrow nav), reusing its CSS, but tracks open components via
 * componentEditorStore instead of pages. Adds one behaviour TabBar doesn't
 * need: a single ephemeral "preview" tab (italic) that gets replaced by the
 * next preview unless double-clicked to pin.
 */

import { useCallback } from 'react';
import { Cube } from '@phosphor-icons/react';
import { useComponentEditorStore } from '../../store/componentEditorStore';
import { useComponentStore } from '@shared/store/componentStore';
import CloseButton from '@shared/components/CloseButton';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useTabStrip, scrollTabsWithWheel } from '@config/hooks/useTabStrip';
import TabCloseContextMenu from '../editor/TabBar/TabCloseContextMenu';
import '../editor/TabBar/style.css';

const ICON_SIZE = 14;

function TabButton({
  tabId,
  isActive,
  isPreview,
  label,
  onOpenContextMenu,
}: {
  tabId: string;
  isActive: boolean;
  isPreview: boolean;
  label: string;
  onOpenContextMenu: (event: React.MouseEvent, tabId: string) => void;
}) {
  const closeTab = useComponentEditorStore((s) => s.closeTab);
  const setActiveTab = useComponentEditorStore((s) => s.setActiveTab);
  const openTab = useComponentEditorStore((s) => s.openTab);

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
      <span className="editor-tabbar__tab-icon">
        <Cube size={ICON_SIZE} weight="regular" />
      </span>
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
  onSelect,
}: {
  isActive: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`editor-tabbar__overflow-item${isActive ? ' editor-tabbar__overflow-item--active' : ''}`}
      onClick={onSelect}
    >
      <span className="editor-tabbar__tab-icon">
        <Cube size={ICON_SIZE} weight="regular" />
      </span>
      {label}
    </button>
  );
}

export default function CompositionTabBar() {
  const openTabIds = useComponentEditorStore((s) => s.openTabIds);
  const previewTabId = useComponentEditorStore((s) => s.previewTabId);
  const activeComponentId = useComponentEditorStore((s) => s.activeComponentId);
  const setActiveTab = useComponentEditorStore((s) => s.setActiveTab);
  const closeTabs = useComponentEditorStore((s) => s.closeTabs);
  const components = useComponentStore((s) => s.components);
  const draftComponents = useComponentStore((s) => s.draftComponents);

  const tabMenu = useContextMenu<{ tabId: string }>();

  const getSnapshot = useCallback(() => {
    const s = useComponentEditorStore.getState();
    return {
      openTabIds: s.openTabIds,
      previewTabId: s.previewTabId,
      activeTabId: s.activeComponentId,
    };
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

  const labelFor = useCallback(
    (id: string) => (draftComponents[id] ?? components.find((c) => c.id === id))?.name ?? id,
    [components, draftComponents],
  );

  if (tabIds.length === 0) return null;

  return (
    <div className="editor-tabbar">
      <div ref={scrollRef} className="editor-tabbar__scroll" onWheel={scrollTabsWithWheel}>
        {tabIds.map((id) => (
          <TabButton
            key={id}
            tabId={id}
            isActive={id === activeComponentId}
            isPreview={id === previewTabId && !openTabIds.includes(id)}
            label={labelFor(id)}
            onOpenContextMenu={(event, tabId) => tabMenu.open(event, { tabId })}
          />
        ))}
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
              {tabIds.map((id) => (
                <OverflowItem
                  key={id}
                  isActive={id === activeComponentId}
                  label={labelFor(id)}
                  onSelect={() => handleDropdownSelect(id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <TabCloseContextMenu tabMenu={tabMenu} tabIds={tabIds} closeTabs={closeTabs} />
    </div>
  );
}
