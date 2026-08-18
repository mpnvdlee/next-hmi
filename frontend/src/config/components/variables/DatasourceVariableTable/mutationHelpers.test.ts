import { describe, it, expect } from 'vitest';
import { setFolderEnabledByIdentity, renameFolderCollapsedKeys } from './mutationHelpers';
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
  it('scopes the toggle to the exact path, not every same-named folder (§3.4)', () => {
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
  it('migrates the folder key and all descendant keys, leaving no stale entries (§3.5)', () => {
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
