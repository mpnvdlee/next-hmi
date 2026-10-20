import { describe, it, expect } from 'vitest';
import { buildFromBrowse, filterTree, updateVarInTree } from './datasourceTreeHelpers';
import type { BrowseNode } from './datasourceTreeHelpers';
import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';

function makeArrayOfStructTree(): TreeNode[] {
  const element = (i: number): FolderEntry => ({
    kind: 'folder',
    name: `[${i}]`,
    children: [{ kind: 'variable', display_name: 'Field1', data_type: 'Float', enabled: true }],
  });
  return [
    {
      kind: 'folder',
      name: 'Arr',
      is_array: true,
      children: [element(0), element(1), element(2)],
    },
  ];
}

describe('updateVarInTree', () => {
  it('scopes the patch to the exact path, not every same-named sibling', () => {
    const tree = makeArrayOfStructTree();
    const result = updateVarInTree(tree, 'Arr/[1]/Field1', undefined, { enabled: false });

    const folder = result[0] as FolderEntry;
    const [el0, el1, el2] = folder.children as FolderEntry[];
    expect((el0.children[0] as VariableEntry).enabled).toBe(true);
    expect((el1.children[0] as VariableEntry).enabled).toBe(false);
    expect((el2.children[0] as VariableEntry).enabled).toBe(true);
  });

  it('matches by node_id when present, regardless of the path argument', () => {
    const tree: TreeNode[] = [
      { kind: 'variable', display_name: 'A', node_id: 'n1', data_type: 'Float', enabled: true },
      { kind: 'variable', display_name: 'B', node_id: 'n2', data_type: 'Float', enabled: true },
    ];
    const result = updateVarInTree(tree, 'A', 'n2', { enabled: false }) as VariableEntry[];
    expect(result[0].enabled).toBe(true);
    expect(result[1].enabled).toBe(false);
  });
});

describe('filterTree', () => {
  const tree: TreeNode[] = [
    {
      kind: 'folder',
      name: 'Line One',
      children: [
        {
          kind: 'variable',
          display_name: 'Motor Speed',
          node_id: 'ns=2;s=drive-speed',
          data_type: 'Float',
          enabled: true,
        },
        {
          kind: 'variable',
          display_name: 'Pressure',
          data_type: 'Float',
          enabled: true,
        },
      ],
    },
  ];

  it('matches all words in any order across the variable path and metadata', () => {
    const result = filterTree(tree, 'speed line float');
    const folder = result[0] as FolderEntry;

    expect(folder.children).toHaveLength(1);
    expect((folder.children[0] as VariableEntry).display_name).toBe('Motor Speed');
    expect(filterTree(tree, 'pressure motor')).toEqual([]);
  });

  it('treats dots in the query as word separators', () => {
    const result = filterTree(tree, 'line.motor.float');
    const folder = result[0] as FolderEntry;

    expect(folder.children).toHaveLength(1);
    expect((folder.children[0] as VariableEntry).display_name).toBe('Motor Speed');
  });

  it('includes a supplied datasource ancestor in matching', () => {
    expect(filterTree(tree, 'plc speed', 'Main PLC')).not.toEqual([]);
    expect(filterTree(tree, 'other speed', 'Main PLC')).toEqual([]);
  });
});

describe('buildFromBrowse', () => {
  // A struct arrives from the browse as a Variable with data_type 'struct' and
  // its members as children. Imported as a variable it would show up as a
  // String — 'struct' is not in the simple-type vocabulary, so toSimpleType
  // falls back — and its members would be dropped.
  const batteryBrowse: BrowseNode[] = [
    {
      node_id: 'ns=3;s=Battery',
      display_name: 'Battery',
      data_type: 'struct',
      writable: false,
      children: [
        { node_id: 'ns=3;s=Battery.SOC', display_name: 'SOC', data_type: 'Float', writable: true },
        {
          node_id: 'ns=3;s=Battery.Voltage',
          display_name: 'Voltage',
          data_type: 'Float',
          writable: true,
        },
      ],
    },
    { node_id: 'ns=3;s=Running', display_name: 'Running', data_type: 'Boolean', writable: false },
  ];

  it('imports a struct as a folder holding its members', () => {
    const tree = buildFromBrowse(batteryBrowse, new Map());

    const battery = tree[0] as FolderEntry;
    expect(battery.kind).toBe('folder');
    expect(battery.name).toBe('Battery');
    // The node_id is kept: the struct-field read path routes through it.
    expect(battery.node_id).toBe('ns=3;s=Battery');
    expect(battery.children.map((c) => (c as VariableEntry).display_name)).toEqual([
      'SOC',
      'Voltage',
    ]);
    expect((battery.children[0] as VariableEntry).data_type).toBe('Float');
  });

  it('leaves a scalar sibling a variable', () => {
    const tree = buildFromBrowse(batteryBrowse, new Map());

    const running = tree[1] as VariableEntry;
    expect(running.kind).toBe('variable');
    expect(running.data_type).toBe('Boolean');
  });

  it('carries the enabled flag onto struct members by node_id', () => {
    const tree = buildFromBrowse(batteryBrowse, new Map([['ns=3;s=Battery.SOC', true]]));

    const battery = tree[0] as FolderEntry;
    expect((battery.children[0] as VariableEntry).enabled).toBe(true);
    expect((battery.children[1] as VariableEntry).enabled).toBe(false);
  });

  it("marks an array of structs from the server's own ValueRank", () => {
    const tree = buildFromBrowse(
      [{ ...batteryBrowse[0], is_array: true, array_length: 4 }],
      new Map(),
    );

    expect(tree[0].kind).toBe('folder');
    expect((tree[0] as FolderEntry).is_array).toBe(true);
  });
});
