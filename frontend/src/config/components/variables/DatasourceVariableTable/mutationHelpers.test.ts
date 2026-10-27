import { describe, it, expect } from 'vitest';
import {
  normalizeArrayStructIndices,
  renameFolderCollapsedKeys,
  setFolderEnabledByIdentity,
} from './mutationHelpers';
import { setEnabledInSubtree } from '@config/components/ui/datasourceTreeHelpers';
import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';

function makeArrayOfStructWithNestedFolder(): TreeNode[] {
  const element = (i: number): FolderEntry => ({
    kind: 'folder',
    name: `[${i}]`,
    children: [
      {
        kind: 'folder',
        name: 'Config',
        children: [{ kind: 'variable', display_name: 'x', data_type: 'Float', enabled: false }],
      },
    ],
  });
  return [{ kind: 'folder', name: 'Arr', is_array: true, children: [element(0), element(1)] }];
}

describe('setFolderEnabledByIdentity', () => {
  it('scopes the toggle to the exact path, not every same-named folder', () => {
    const tree = makeArrayOfStructWithNestedFolder();
    const result = setFolderEnabledByIdentity(
      tree,
      'Arr/[0]/Config',
      undefined,
      true,
      setEnabledInSubtree,
    );

    const arr = result[0] as FolderEntry;
    const [el0, el1] = arr.children as FolderEntry[];
    const config0 = el0.children[0] as FolderEntry;
    const config1 = el1.children[0] as FolderEntry;
    expect((config0.children[0] as VariableEntry).enabled).toBe(true);
    expect((config1.children[0] as VariableEntry).enabled).toBe(false);
  });

  it('matches by node_id when present, regardless of the path argument', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'A',
        node_id: 'f1',
        children: [{ kind: 'variable', display_name: 'x', data_type: 'Float', enabled: false }],
      },
      {
        kind: 'folder',
        name: 'B',
        node_id: 'f2',
        children: [{ kind: 'variable', display_name: 'y', data_type: 'Float', enabled: false }],
      },
    ];
    const result = setFolderEnabledByIdentity(tree, 'A', 'f2', true, setEnabledInSubtree);
    const [a, b] = result as FolderEntry[];
    expect((a.children[0] as VariableEntry).enabled).toBe(false);
    expect((b.children[0] as VariableEntry).enabled).toBe(true);
  });
});

describe('renameFolderCollapsedKeys', () => {
  it('migrates the folder key and all descendant keys, leaving no stale entries', () => {
    const collapsed = new Set(['Motors', 'Motors/Diagnostics', 'Other']);
    const result = renameFolderCollapsedKeys(collapsed, 'Motors', 'Devices');

    expect(result.has('Devices')).toBe(true);
    expect(result.has('Devices/Diagnostics')).toBe(true);
    expect(result.has('Other')).toBe(true);
    expect([...result].some((key) => key.startsWith('Motors'))).toBe(false);
  });

  it('only rewrites the renamed folder and its descendants, not similarly-prefixed siblings', () => {
    const collapsed = new Set(['Motors', 'MotorsBackup']);
    const result = renameFolderCollapsedKeys(collapsed, 'Motors', 'Devices');

    expect(result.has('Devices')).toBe(true);
    expect(result.has('MotorsBackup')).toBe(true);
  });

  it('rewrites nested folder paths using the shared prefix', () => {
    const collapsed = new Set(['A/Motors', 'A/Motors/Diagnostics']);
    const result = renameFolderCollapsedKeys(collapsed, 'A/Motors', 'Devices');

    expect(result.has('A/Devices')).toBe(true);
    expect(result.has('A/Devices/Diagnostics')).toBe(true);
  });
});

describe('normalizeArrayStructIndices node ids', () => {
  const element = (name: string, nodeId: string, children: TreeNode[]): TreeNode => ({
    kind: 'folder',
    name,
    node_id: nodeId,
    children,
  });
  const variable = (name: string, nodeId: string): TreeNode => ({
    kind: 'variable',
    display_name: name,
    node_id: nodeId,
    data_type: 'Float',
    enabled: true,
  });
  const copiedId = (tree: TreeNode[]) =>
    ((tree[0] as FolderEntry).children[1] as FolderEntry).children.map((c) => c.node_id);

  it('moves a copied member to its element when the id is a path below the element', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'a',
        children: [
          element('[0]', 'ns=4;s=GVL.a[0]', [variable('x', 'ns=4;s=GVL.a[0].x')]),
          element('[1]', 'ns=4;s=GVL.a[1]', []),
        ],
      },
    ];
    expect(copiedId(normalizeArrayStructIndices(tree))).toEqual(['ns=4;s=GVL.a[1].x']);
  });

  it('keeps an opaque OPC-UA id it cannot derive, as before', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'a',
        children: [
          element('[0]', 'ns=2;i=10', [variable('x', 'ns=2;i=101')]),
          element('[1]', 'ns=2;i=20', []),
        ],
      },
    ];
    expect(copiedId(normalizeArrayStructIndices(tree))).toEqual(['ns=2;i=101']);
  });

  it('keeps the id when the target element id has another shape', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'a',
        children: [
          element('[0]', 'ns=4;s=GVL.a[0]', [variable('x', 'ns=4;s=GVL.a[0].x')]),
          element('[1]', 'ns=4;i=77', []),
        ],
      },
    ];
    expect(copiedId(normalizeArrayStructIndices(tree))).toEqual(['ns=4;s=GVL.a[0].x']);
  });

  it('rebases an ADS path onto an ADS path', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'aPoints',
        children: [
          element('[0]', 'MAIN.aPoints[1]', [variable('x', 'MAIN.aPoints[1].x')]),
          element('[1]', 'MAIN.aPoints[2]', []),
        ],
      },
    ];
    expect(copiedId(normalizeArrayStructIndices(tree))).toEqual(['MAIN.aPoints[2].x']);
  });
});
