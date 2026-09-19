import type { ReactNode } from 'react';
import {
  ContextMenu as SharedContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '../../ui/ContextMenu';
import type { ContextMenuState } from './types';

interface ContextMenuProps {
  menu: ContextMenuState;
  onClose: () => void;
  onAction: (action: string) => void;
}

export default function ContextMenu({ menu, onClose, onAction }: ContextMenuProps) {
  const btn = (label: string, action: string, danger = false) => (
    <ContextMenuItem
      key={action}
      danger={danger}
      onClick={() => {
        onAction(action);
        onClose();
      }}
    >
      {label}
    </ContextMenuItem>
  );

  const sep = (key: string) => <ContextMenuSeparator key={key} />;

  /** Picking a type always goes through the selector drawer. */
  const addWidgetItem = btn('Add Widget/Component…', 'openWidgetSelector');

  const items: ReactNode[] = [];
  if (menu.kind === 'pages-root' || menu.kind === 'dialogs-root') {
    items.push(
      btn(menu.kind === 'dialogs-root' ? 'Add Dialog' : 'Add Page', 'addPage'),
      btn(menu.kind === 'dialogs-root' ? 'Add Dialog Group' : 'Add Page Group', 'addPageGroup'),
      sep('s1'),
      btn('Paste', 'paste'),
    );
  } else if (menu.kind === 'page-group') {
    items.push(
      btn('Add Page', 'addPageToPageGroup'),
      btn('Add Page Group', 'addPageGroup'),
      sep('s1'),
      btn('Rename', 'rename'),
      sep('s2'),
      btn('Cut', 'cut'),
      btn('Copy', 'copy'),
      btn('Paste', 'paste'),
      sep('s3'),
      btn('Delete Page Group', 'deletePageGroup', true),
    );
  } else if (menu.kind === 'page') {
    // Adding at the page level always targets the content section, even when
    // the page has Header/Content/Footer folders (see addComponentToPage).
    items.push(
      btn('Add Container', 'addContainer'),
      addWidgetItem,
      sep('s1'),
      btn('Rename', 'rename'),
      sep('s2'),
      btn('Cut', 'cut'),
      btn('Copy', 'copy'),
      btn('Paste', 'paste'),
      sep('s3'),
      btn('Delete Page', 'deletePage', true),
    );
  } else if (
    menu.kind === 'page-section' ||
    menu.kind === 'page-group-section' ||
    menu.kind === 'widget-slot' ||
    menu.kind === 'area'
  ) {
    items.push(
      btn('Add Container', 'addContainer'),
      addWidgetItem,
      sep('s1'),
      btn('Paste', 'paste'),
    );
  } else if (menu.kind === 'container') {
    items.push(
      addWidgetItem,
      btn('Add Container', 'addContainer'),
      sep('s1'),
      btn('Duplicate', 'duplicate'),
      btn('Cut', 'cut'),
      btn('Copy', 'copy'),
      btn('Paste', 'paste'),
      sep('s3'),
      btn('Delete', 'delete', true),
    );
  } else {
    items.push(
      btn('Duplicate', 'duplicate'),
      sep('s1'),
      btn('Cut', 'cut'),
      btn('Copy', 'copy'),
      btn('Paste', 'paste'),
      sep('s2'),
      btn('Delete', 'delete', true),
    );
  }

  return (
    <SharedContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      {items}
    </SharedContextMenu>
  );
}
