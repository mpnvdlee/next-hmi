import type { ReactNode } from 'react';
import type { WidgetConfig } from '@shared/types/config';
import WidgetRenderer from './WidgetRenderer';

export function renderRegionChildren(
  components: WidgetConfig[],
  fallback: ReactNode = null,
): ReactNode {
  if (components.length === 0) return fallback;
  return components.map((comp) => <WidgetRenderer key={comp.id} node={comp} />);
}
