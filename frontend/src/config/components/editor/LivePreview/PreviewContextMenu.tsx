import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '../../ui/ContextMenu';
import type { PreviewInsertTarget } from './previewInsertTarget';

interface Props {
  x: number;
  y: number;
  target: PreviewInsertTarget;
  /** The widget under the cursor, when the click landed on one. */
  widget: { id: string; name: string } | null;
  onClose: () => void;
  onAction: (action: string) => void;
}

/** Right-click menu for the live preview. Adding targets the container that will
 *  hold the new widget; Copy and Delete act on the widget that was clicked. The
 *  tree keeps the rest (renaming, moving, page and dialog level actions). */
export default function PreviewContextMenu({ x, y, target, widget, onClose, onAction }: Props) {
  const run = (action: string) => {
    onAction(action);
    onClose();
  };

  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <ContextMenuLabel>Add to {target.name}</ContextMenuLabel>
      <ContextMenuItem onClick={() => run('openWidgetSelector')}>
        Add Widget/Component…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => run('addContainer')}>Add Container</ContextMenuItem>
      <ContextMenuSeparator />
      {widget && <ContextMenuLabel>{widget.name}</ContextMenuLabel>}
      {widget && <ContextMenuItem onClick={() => run('cut')}>Cut</ContextMenuItem>}
      {widget && <ContextMenuItem onClick={() => run('copy')}>Copy</ContextMenuItem>}
      <ContextMenuItem onClick={() => run('paste')}>Paste</ContextMenuItem>
      {widget && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem danger onClick={() => run('delete')}>
            Delete
          </ContextMenuItem>
        </>
      )}
    </ContextMenu>
  );
}
