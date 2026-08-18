/** Row-key encoding shared by WidgetPropPicker and the `$widgetProp` editor:
 *  `<componentId>\0<property>[/<field path>]`. The editor builds it to preselect
 *  the binding a field already holds; the picker parses it back on confirm. */
export const COMPOSITE_KEY_SEP = '\x00';

export interface WidgetPropSelection {
  componentId: string;
  property: string;
  path?: string;
}

export function widgetPropRowKey(componentId: string, property: string, path?: string): string {
  return `${componentId}${COMPOSITE_KEY_SEP}${property}${path ? `/${path}` : ''}`;
}

export function parseWidgetPropRowKey(key: string): WidgetPropSelection | null {
  const sepIdx = key.indexOf(COMPOSITE_KEY_SEP);
  if (sepIdx === -1) return null;
  const componentId = key.slice(0, sepIdx);
  const rest = key.slice(sepIdx + 1);
  const slashIdx = rest.indexOf('/');
  return slashIdx === -1
    ? { componentId, property: rest }
    : { componentId, property: rest.slice(0, slashIdx), path: rest.slice(slashIdx + 1) };
}
