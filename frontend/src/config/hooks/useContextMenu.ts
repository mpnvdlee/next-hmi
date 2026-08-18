import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * Tracks an `{ x, y, ...data } | null` context-menu state.
 *
 * Usage:
 *   const groupMenu = useContextMenu<{ id: string; name: string }>();
 *   ...
 *   onContextMenu={(e) => groupMenu.open(e, { id, name })}
 *   ...
 *   {groupMenu.state && (
 *     <ContextMenu x={groupMenu.state.x} y={groupMenu.state.y} onClose={groupMenu.close}>
 *       ...
 *     </ContextMenu>
 *   )}
 */
export interface ContextMenuHandle<T> {
  state: ({ x: number; y: number } & T) | null;
  open: (e: ReactMouseEvent, data: T) => void;
  close: () => void;
}

export function useContextMenu<T = Record<string, never>>(): ContextMenuHandle<T> {
  const [state, setState] = useState<({ x: number; y: number } & T) | null>(null);
  const open = useCallback((e: ReactMouseEvent, data: T) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, ...data });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, close };
}
