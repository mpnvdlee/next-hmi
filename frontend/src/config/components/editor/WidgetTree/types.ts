export type { CSSWithVars } from '@shared/types/style';

export type NodeKind =
  | 'page'
  | 'page-section'
  | 'page-group'
  | 'page-group-section'
  | 'pages-root'
  | 'dialog-page'
  | 'area'
  | 'container'
  /** One named slot of a reusable-component instance. */
  | 'widget-slot'
  | 'leaf';

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  kind: NodeKind;
}
