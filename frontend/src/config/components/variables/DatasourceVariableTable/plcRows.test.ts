import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@shared/types/datasource';
import type { BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { savedNodeIds } from './browseMerge';
import { filterBrowse, flattenWithPlc, type PlcOverlay, type TableRow } from './plcRows';

const leaf = (node_id: string, data_type = 'Boolean'): BrowseNode => ({
  node_id,
  display_name: node_id.split('.').pop()!,
  data_type,
});

const PLC: BrowseNode[] = [
  {
    node_id: 'MAIN',
    display_name: 'MAIN',
    data_type: null,
    children: [
      leaf('MAIN.bStart'),
      leaf('MAIN.fSpeed', 'Double'),
      {
        node_id: 'MAIN.stMotor',
        display_name: 'stMotor',
        data_type: 'struct',
        children: [leaf('MAIN.stMotor.bRunning')],
      },
    ],
  },
  {
    node_id: 'GVL',
    display_name: 'GVL',
    data_type: null,
    children: [
      {
        node_id: 'GVL.stLazy',
        display_name: 'stLazy',
        data_type: 'struct',
        children: [],
        has_children: true,
      },
    ],
  },
];

const SAVED: TreeNode[] = [
  {
    kind: 'folder',
    name: 'MAIN',
    node_id: 'MAIN',
    children: [
      {
        kind: 'variable',
        node_id: 'MAIN.bStart',
        display_name: 'bStart',
        data_type: 'Boolean',
        enabled: true,
      },
    ],
  },
];

function overlay(open: string[] | null, extra: Partial<PlcOverlay> = {}): PlcOverlay {
  return {
    nodes: PLC,
    saved: savedNodeIds(SAVED),
    open: open && new Set(open),
    loaded: new Set(),
    loading: new Set(),
    ...extra,
  };
}

function describeRows(rows: TableRow[]): string[] {
  return rows.map((r) =>
    r.kind === 'plc' ? `+${'  '.repeat(r.depth)}${r.path}` : `${'  '.repeat(r.depth)}${r.path}`,
  );
}

describe('flattenWithPlc', () => {
  it('weaves the PLC nodes the datasource lacks in under their saved folder', () => {
    const rows = flattenWithPlc(SAVED, new Set(), overlay(['MAIN.stMotor']));
    expect(describeRows(rows)).toEqual([
      'MAIN',
      '  MAIN/bStart',
      '+  MAIN/fSpeed',
      '+  MAIN/stMotor',
      '+    MAIN/stMotor/bRunning',
      '+GVL',
    ]);
  });

  it('keeps a closed PLC folder shut and offers its loaded new variables in one tick', () => {
    const rows = flattenWithPlc(SAVED, new Set(), overlay([]));
    const motor = rows.find((r) => r.kind === 'plc' && r.path === 'MAIN/stMotor');
    expect(motor).toMatchObject({ open: false, newIds: ['MAIN.stMotor.bRunning'] });
    expect(rows.some((r) => r.path === 'MAIN/stMotor/bRunning')).toBe(false);
  });

  it('marks a lazy folder not loaded yet, with nothing to add until it is', () => {
    const rows = flattenWithPlc(SAVED, new Set(), overlay(['GVL']));
    expect(rows.find((r) => r.path === 'GVL/stLazy')).toMatchObject({
      unloaded: true,
      newIds: [],
    });
  });

  it('hides the PLC rows of a collapsed saved folder', () => {
    const rows = flattenWithPlc(SAVED, new Set(['MAIN']), overlay(null));
    expect(describeRows(rows)).toEqual(['MAIN', '+GVL', '+  GVL/stLazy']);
  });

  it('asks for the lazy level of an open saved folder', () => {
    const lazy: BrowseNode[] = [
      { node_id: 'MAIN', display_name: 'MAIN', data_type: null, children: [], has_children: true },
    ];
    const wanted: string[] = [];
    const rows = flattenWithPlc(SAVED, new Set(), overlay([], { nodes: lazy }), wanted);
    expect(wanted).toEqual(['MAIN']);
    expect(rows.some((r) => r.kind === 'plc')).toBe(false);
  });

  it('leaves the saved rows as they are without a PLC overlay', () => {
    expect(describeRows(flattenWithPlc(SAVED, new Set(), null))).toEqual(['MAIN', '  MAIN/bStart']);
  });
});

describe('filterBrowse', () => {
  it('keeps the matches and the folders leading to them', () => {
    const out = filterBrowse(PLC, 'running');
    expect(out).toHaveLength(1);
    expect(out[0].children?.[0].children?.map((n) => n.node_id)).toEqual(['MAIN.stMotor.bRunning']);
  });

  it('matches a node id with dots and a data type', () => {
    expect(filterBrowse(PLC, 'MAIN.fSpeed')[0].children?.map((n) => n.node_id)).toEqual([
      'MAIN.fSpeed',
    ]);
    expect(filterBrowse(PLC, 'double')[0].children?.map((n) => n.node_id)).toEqual(['MAIN.fSpeed']);
  });
});
