import { ContextMenu, ContextMenuItem } from '@config/components/ui/ContextMenu';
import type { ContextMenuHandle } from '@config/hooks/useContextMenu';

export default function TabCloseContextMenu({
  tabMenu,
  tabIds,
  closeTabs,
}: {
  tabMenu: ContextMenuHandle<{ tabId: string }>;
  tabIds: string[];
  closeTabs: (ids: string[]) => void;
}) {
  if (!tabMenu.state) return null;
  const { tabId, x, y } = tabMenu.state;

  return (
    <ContextMenu x={x} y={y} onClose={tabMenu.close}>
      <ContextMenuItem
        onClick={() => {
          closeTabs([tabId]);
          tabMenu.close();
        }}
      >
        Close tab
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          closeTabs(tabIds.filter((id) => id !== tabId));
          tabMenu.close();
        }}
      >
        Close all others
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          closeTabs(tabIds);
          tabMenu.close();
        }}
      >
        Close all tabs
      </ContextMenuItem>
    </ContextMenu>
  );
}
