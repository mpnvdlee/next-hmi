import { describe, it, expect } from 'vitest';
import { filterTree, updateVarInTree } from './datasourceTreeHelpers';
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
  it('scopes the patch to the exact path, not every same-named sibling (§3.3)', () => {
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
