import { describe, expect, it } from 'vitest';
import type { PageConfig, PageGroupConfig, WidgetConfig } from '@shared/types/config';
import { filterComponents, filterPage, filterPageGroup } from './treeFilters';

const motor: WidgetConfig = { id: 'motor-1', type: 'NumericDisplay', name: 'Motor Speed' };
const pressure: WidgetConfig = { id: 'pressure-1', type: 'Gauge', name: 'Pressure' };

function page(title: string, widgets: WidgetConfig[]): PageConfig {
  return { id: title.toLowerCase(), title, sections: { main: widgets } } as PageConfig;
}

describe('editor tree search filters', () => {
  it('matches every word in any order across component ancestors', () => {
    const components: WidgetConfig[] = [
      { id: 'container', type: 'Container', name: 'Drive Panel', children: [motor, pressure] },
    ];

    const result = filterComponents(components, 'speed drive');
    expect(result).toHaveLength(1);
    expect(result[0].children).toEqual([motor]);
    expect(filterComponents(components, 'speed pressure')).toEqual([]);
  });

  it('treats dots in the query as word separators', () => {
    const result = filterComponents(
      [{ id: 'container', type: 'Container', name: 'Drive Panel', children: [motor] }],
      'drive.speed',
    );

    expect(result[0].children).toEqual([motor]);
  });

  it('allows a query to span a page title and widget label', () => {
    const result = filterPage(page('Production Line', [motor, pressure]), 'motor production');
    expect(result?.sections.main).toEqual([motor]);
  });

  it('includes page sections in each widget path', () => {
    const result = filterPage(page('Production Line', [motor, pressure]), 'main motor');
    expect(result?.sections.main).toEqual([motor]);
  });

  it('includes page-group parents in a descendant path', () => {
    const group: PageGroupConfig = {
      id: 'area-a',
      title: 'Area A',
      children: [page('Overview', [motor])],
    } as PageGroupConfig;

    const result = filterPageGroup(group, 'area motor');
    expect(result?.children).toHaveLength(1);
    expect(filterPageGroup(group, 'area pressure')).toBeNull();
  });

  it('searches page-group header and footer widget paths', () => {
    const group: PageGroupConfig = {
      id: 'area-a',
      title: 'Area A',
      header: [motor],
      footer: [pressure],
      children: [],
    } as unknown as PageGroupConfig;

    const result = filterPageGroup(group, 'header motor');
    expect(result?.header).toEqual([motor]);
    expect(result?.footer).toEqual([]);
  });
});
