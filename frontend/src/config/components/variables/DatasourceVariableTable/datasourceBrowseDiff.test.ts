import type { TreeNode, VariableEntry } from '@shared/types/datasource';
import {
  applyBrowseDiff,
  computeBrowseDiff,
  diffSelectionKey,
  isEmptyDiff,
  type ModifiedEntry,
  type ModifiedRow,
} from './datasourceBrowseDiff';

function v(
  node_id: string,
  display_name: string,
  overrides: Partial<VariableEntry> = {},
): VariableEntry {
  return {
    kind: 'variable',
    node_id,
    display_name,
    data_type: 'Int32',
    enabled: false,
    writable: false,
    ...overrides,
  };
}

function asModified(row: ModifiedEntry): ModifiedRow {
  if (row.kind !== 'modified') throw new Error('expected a plain modified row, got folder-rename');
  return row;
}

function folder(name: string, children: TreeNode[]): TreeNode {
  return { kind: 'folder', name, children };
}

describe('computeBrowseDiff', () => {
  it('returns empty diff for identical trees', () => {
    const tree: TreeNode[] = [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B')];
    const diff = computeBrowseDiff(
      tree,
      tree.map((n) => ({ ...n })),
    );
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.silentReactivations).toHaveLength(0);
  });

  it('detects added variables', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A')];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B')];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].node_id).toBe('ns=1;i=2');
    expect(diff.added[0].path).toBe('B');
    expect(diff.added[0].parentPath).toBe('');
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it('detects added variables inside a folder', () => {
    const saved: TreeNode[] = [];
    const browse: TreeNode[] = [folder('Motors', [v('ns=1;i=3', 'Speed')])];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].parentPath).toBe('Motors');
    expect(diff.added[0].path).toBe('Motors/Speed');
  });

  it('detects removed variables', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B')];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].node_id).toBe('ns=1;i=2');
  });

  it('does not re-surface already-stale variables that are still absent', () => {
    const saved: TreeNode[] = [
      v('ns=1;i=1', 'A'),
      v('ns=1;i=2', 'B', { present_on_server: false }),
    ];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.removed).toHaveLength(0);
  });

  it('detects modified data_type', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { data_type: 'Int32' })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A', { data_type: 'Float' })];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    expect(asModified(diff.modified[0]).changedFields).toEqual(['data_type']);
  });

  it('detects modified writable, array_length, display_name', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { writable: false, array_length: 4 })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A2', { writable: true, array_length: 8 })];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    expect(asModified(diff.modified[0]).changedFields.sort()).toEqual([
      'array_length',
      'display_name',
      'writable',
    ]);
  });

  it('detects fields changes on structs', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'S', { kind: 'struct', fields: { a: 'Int32' } })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'S', { kind: 'struct', fields: { a: 'Float' } })];
    const diff = computeBrowseDiff(saved, browse);
    expect(asModified(diff.modified[0]).changedFields).toEqual(['fields']);
  });

  it('detects parent_path change as Modified (no Renamed category)', () => {
    const saved: TreeNode[] = [folder('OldFolder', [v('ns=1;i=1', 'A')])];
    const browse: TreeNode[] = [folder('NewFolder', [v('ns=1;i=1', 'A')])];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    const row = asModified(diff.modified[0]);
    expect(row.changedFields).toEqual(['parent_path']);
    expect(row.beforePath).toBe('OldFolder/A');
    expect(row.afterPath).toBe('NewFolder/A');
  });

  it('groups a folder rename shared by 3+ leaves into a single folder-rename row', () => {
    const saved: TreeNode[] = [
      folder('OldFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const browse: TreeNode[] = [
      folder('NewFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    const [row] = diff.modified;
    expect(row.kind).toBe('folder-rename');
    if (row.kind === 'folder-rename') {
      expect(row.beforeParent).toBe('OldFolder');
      expect(row.afterParent).toBe('NewFolder');
      expect(row.rows.map((r) => r.node_id).sort()).toEqual(['ns=1;i=1', 'ns=1;i=2', 'ns=1;i=3']);
      expect(row.node_id).not.toBe('ns=1;i=1');
      expect(row.node_id).not.toBe('ns=1;i=2');
      expect(row.node_id).not.toBe('ns=1;i=3');
    }
  });

  it('does not group a lone parent_path change (single leaf) into a folder-rename row', () => {
    const saved: TreeNode[] = [folder('OldFolder', [v('ns=1;i=1', 'A')])];
    const browse: TreeNode[] = [folder('NewFolder', [v('ns=1;i=1', 'A')])];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].kind).toBe('modified');
  });

  it('silently reactivates a stale variable whose metadata matches', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { present_on_server: false })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.silentReactivations).toEqual(['ns=1;i=1']);
    expect(diff.modified).toHaveLength(0);
  });

  it('surfaces a stale variable with changed metadata as Modified AND silently reactivates it', () => {
    // A var that's both back AND has changed metadata must reactivate
    // regardless of whether the user accepts the metadata change — the server
    // says it's there, so leaving it stale would be a stale-data bug.
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { present_on_server: false, writable: false })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A', { writable: true })];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.silentReactivations).toEqual(['ns=1;i=1']);
    expect(diff.modified).toHaveLength(1);
    expect(asModified(diff.modified[0]).changedFields).toEqual(['writable']);
  });
});

describe('applyBrowseDiff', () => {
  it('marks unchecked Removed vars as stale instead of deleting them', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B', { enabled: true })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    expect(next).toHaveLength(2);
    const stale = next.find((n) => 'node_id' in n && n.node_id === 'ns=1;i=2') as VariableEntry;
    expect(stale.present_on_server).toBe(false);
    expect(stale.enabled).toBe(true);
  });

  it('deletes Removed vars when checked', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B')];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('removed', 'ns=1;i=2')]),
    });
    expect(next).toHaveLength(1);
  });

  it('inserts Added vars when checked, with enabled=false', () => {
    const saved: TreeNode[] = [];
    const browse: TreeNode[] = [folder('Motors', [v('ns=1;i=3', 'Speed', { enabled: true })])];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('added', 'ns=1;i=3')]),
    });
    const motors = next.find((n) => n.kind === 'folder' && n.name === 'Motors');
    expect(motors).toBeDefined();
    if (motors && motors.kind === 'folder') {
      const child = motors.children[0] as VariableEntry;
      expect(child.node_id).toBe('ns=1;i=3');
      expect(child.enabled).toBe(false);
    }
  });

  it('does not insert Added vars when unchecked', () => {
    const saved: TreeNode[] = [];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    expect(next).toHaveLength(0);
  });

  it('updates metadata for checked Modified vars', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { data_type: 'Int32' })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A', { data_type: 'Float' })];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('modified', 'ns=1;i=1')]),
    });
    expect((next[0] as VariableEntry).data_type).toBe('Float');
  });

  it('relocates a Modified var when parent_path changed', () => {
    const saved: TreeNode[] = [folder('OldFolder', [v('ns=1;i=1', 'A', { enabled: true })])];
    const browse: TreeNode[] = [folder('NewFolder', [v('ns=1;i=1', 'A')])];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('modified', 'ns=1;i=1')]),
    });
    expect(next.find((n) => n.kind === 'folder' && n.name === 'OldFolder')).toBeUndefined();
    const newF = next.find((n) => n.kind === 'folder' && n.name === 'NewFolder');
    expect(newF).toBeDefined();
    if (newF && newF.kind === 'folder') {
      expect((newF.children[0] as VariableEntry).enabled).toBe(true);
    }
  });

  it('clears stale flag on silent reactivation regardless of selection', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { present_on_server: false, enabled: true })];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    const entry = next[0] as VariableEntry;
    expect(entry.present_on_server).toBeUndefined();
    expect(entry.enabled).toBe(true);
  });

  it('keeps enabled flag intact when marking removed as stale', () => {
    const saved: TreeNode[] = [v('ns=1;i=1', 'A', { enabled: true })];
    const browse: TreeNode[] = [];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    const entry = next[0] as VariableEntry;
    expect(entry.present_on_server).toBe(false);
    expect(entry.enabled).toBe(true);
  });

  it('clears stale flag even when its Modified row is unchecked', () => {
    // Var was stale, then reappears with changed metadata. User declines the
    // metadata update but the var is provably back — the stale flag should
    // clear regardless.
    const saved: TreeNode[] = [
      v('ns=1;i=1', 'A', { present_on_server: false, writable: false, enabled: true }),
    ];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A', { writable: true })];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    const entry = next[0] as VariableEntry;
    expect(entry.present_on_server).toBeUndefined();
    // Metadata unchanged because Modified was unchecked.
    expect(entry.writable).toBe(false);
    expect(entry.enabled).toBe(true);
  });

  it('moves all 3 fields together when a grouped folder-rename row is accepted', () => {
    const saved: TreeNode[] = [
      folder('OldFolder', [
        v('ns=1;i=1', 'A', { enabled: true }),
        v('ns=1;i=2', 'B', { enabled: true }),
        v('ns=1;i=3', 'C', { enabled: true }),
      ]),
    ];
    const browse: TreeNode[] = [
      folder('NewFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const diff = computeBrowseDiff(saved, browse);
    expect(diff.modified).toHaveLength(1);
    const groupKey = diff.modified[0].node_id;
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('modified', groupKey)]),
    });
    expect(next.find((n) => n.kind === 'folder' && n.name === 'OldFolder')).toBeUndefined();
    const newFolder = next.find((n) => n.kind === 'folder' && n.name === 'NewFolder');
    expect(newFolder).toBeDefined();
    if (newFolder && newFolder.kind === 'folder') {
      expect(newFolder.children.map((c) => (c as VariableEntry).node_id).sort()).toEqual([
        'ns=1;i=1',
        'ns=1;i=2',
        'ns=1;i=3',
      ]);
      expect(newFolder.children.every((c) => (c as VariableEntry).enabled)).toBe(true);
    }
  });

  it('leaves all 3 fields under the old folder when the grouped row is left unchecked', () => {
    const saved: TreeNode[] = [
      folder('OldFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const browse: TreeNode[] = [
      folder('NewFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const diff = computeBrowseDiff(saved, browse);
    const next = applyBrowseDiff({ savedTree: saved, diff, selected: new Set() });
    const oldFolder = next.find((n) => n.kind === 'folder' && n.name === 'OldFolder');
    expect(oldFolder).toBeDefined();
    if (oldFolder && oldFolder.kind === 'folder') {
      expect(oldFolder.children).toHaveLength(3);
    }
    expect(next.find((n) => n.kind === 'folder' && n.name === 'NewFolder')).toBeUndefined();
  });

  it('has no way to strand a single field: a grouped rename has no per-leaf selection key', () => {
    const saved: TreeNode[] = [
      folder('OldFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const browse: TreeNode[] = [
      folder('NewFolder', [v('ns=1;i=1', 'A'), v('ns=1;i=2', 'B'), v('ns=1;i=3', 'C')]),
    ];
    const diff = computeBrowseDiff(saved, browse);
    // Selecting a member's own node_id (as a per-leaf key) does nothing: the
    // only selectable key for a grouped rename is the group's synthetic id.
    const next = applyBrowseDiff({
      savedTree: saved,
      diff,
      selected: new Set([diffSelectionKey('modified', 'ns=1;i=1')]),
    });
    const oldFolder = next.find((n) => n.kind === 'folder' && n.name === 'OldFolder');
    expect(oldFolder).toBeDefined();
    if (oldFolder && oldFolder.kind === 'folder') {
      expect(oldFolder.children).toHaveLength(3);
    }
  });

  it('does not double-insert when an Added node_id already exists in the tree', () => {
    // Diff was computed against an older tree; user then hand-added a var
    // with the same node_id before clicking Apply.
    const oldSaved: TreeNode[] = [];
    const browse: TreeNode[] = [v('ns=1;i=1', 'A')];
    const diff = computeBrowseDiff(oldSaved, browse);
    const currentTree: TreeNode[] = [v('ns=1;i=1', 'A', { enabled: true })];
    const next = applyBrowseDiff({
      savedTree: currentTree,
      diff,
      selected: new Set([diffSelectionKey('added', 'ns=1;i=1')]),
    });
    expect(next).toHaveLength(1);
    expect((next[0] as VariableEntry).enabled).toBe(true);
  });
});
