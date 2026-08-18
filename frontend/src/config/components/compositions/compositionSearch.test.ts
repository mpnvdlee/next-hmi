import { describe, expect, it } from 'vitest';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import { filterCompositions } from './compositionSearch';

const motor: WidgetConfig = { id: 'motor-1', type: 'NumericDisplay', name: 'Motor Speed' };
const pressure: WidgetConfig = { id: 'pressure-1', type: 'Gauge', name: 'Pressure' };

function definition(
  id: string,
  name: string,
  group: string | null,
  children: WidgetConfig[] = [],
): ComponentDefinition {
  return { id, name, group, componentProperties: {}, children };
}

const drivePanel = definition('c1', 'Drive Panel', 'Machines', [motor, pressure]);
const alarmBanner = definition('c2', 'Alarm Banner', 'Machines/Nested');
const looseCard = definition('c3', 'Status Card', null, [pressure]);
const folders = ['Machines', 'Machines/Nested', 'Reports'];
const widgets = [drivePanel, alarmBanner, looseCard];

describe('filterCompositions', () => {
  it('returns the inputs untouched for an empty query', () => {
    const result = filterCompositions(widgets, folders, '  ');
    expect(result.widgets).toBe(widgets);
    expect(result.folders).toBe(folders);
  });

  it('keeps a component matched by name whole', () => {
    const result = filterCompositions(widgets, folders, 'drive');
    expect(result.widgets).toEqual([drivePanel]);
    expect(result.widgets[0].children).toEqual([motor, pressure]);
    expect(result.folders).toEqual(['Machines']);
  });

  it('keeps only the branch of a component a widget matched in', () => {
    const result = filterCompositions(widgets, folders, 'motor');
    expect(result.widgets).toHaveLength(1);
    expect(result.widgets[0].children).toEqual([motor]);
  });

  it('spans the folder path, the component name and the widget label', () => {
    const result = filterCompositions(widgets, folders, 'machines pressure');
    expect(result.widgets).toHaveLength(1);
    expect(result.widgets[0].children).toEqual([pressure]);
  });

  it('shows everything under a folder matched by name', () => {
    const result = filterCompositions(widgets, folders, 'nested');
    expect(result.widgets).toEqual([alarmBanner]);
    // The parent survives so the tree can nest the matched folder under it.
    expect(result.folders).toEqual(['Machines', 'Machines/Nested']);
  });

  it('drops folders and components nothing matched in', () => {
    const result = filterCompositions(widgets, folders, 'status');
    expect(result.widgets).toEqual([looseCard]);
    expect(result.folders).toEqual([]);
  });
});
