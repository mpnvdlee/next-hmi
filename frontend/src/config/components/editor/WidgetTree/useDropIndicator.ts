import { useContext } from 'react';
import { DropIndicatorContext } from './dropIndicatorContext';

/** `{ edge, into }` for this row, both empty when the drag is elsewhere. */
export function useDropIndicator(nodeId: string): { edge?: 'top' | 'bottom'; into: boolean } {
  const indicator = useContext(DropIndicatorContext);
  if (!indicator || indicator.overId !== nodeId) return { into: false };
  return { edge: indicator.edge, into: indicator.into };
}
