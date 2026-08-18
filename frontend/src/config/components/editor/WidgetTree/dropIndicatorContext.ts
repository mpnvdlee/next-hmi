/**
 * What the tree is about to do with the node being dragged, published to the
 * rows so the hovered one can draw an insert line (beside) or a ring (inside)
 * without every row subscribing to the drag itself.
 */

import { createContext } from 'react';

export interface DropIndicator {
  overId: string;
  edge?: 'top' | 'bottom';
  into: boolean;
}

export const DropIndicatorContext = createContext<DropIndicator | null>(null);
