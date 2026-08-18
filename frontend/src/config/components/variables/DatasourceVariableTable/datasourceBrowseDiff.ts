import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';

export type ChangedField =
  | 'data_type'
  | 'writable'
  | 'is_array'
  | 'array_length'
  | 'fields'
  | 'display_name'
  | 'parent_path';

export interface AddedRow {
  kind: 'added';
  node_id: string;
  path: string;
  parentPath: string;
  entry: VariableEntry;
}

export interface RemovedRow {
  kind: 'removed';
  node_id: string;
  path: string;
  entry: VariableEntry;
}

export interface ModifiedRow {
  kind: 'modified';
  node_id: string;
  beforePath: string;
  afterPath: string;
  before: VariableEntry;
  after: VariableEntry;
  changedFields: ChangedField[];
}

// A server-side folder rename turns every child leaf into its own
// parent_path-changed ModifiedRow. Accepting those independently lets a user
// move some fields but not others, stranding the rest under a folder path
// that no longer exists on the server. When 2+ leaves share the same
// old-parent -> new-parent transition, they're collapsed into one
// all-or-nothing row instead - node_id is a synthetic group id, not a real
// OPC-UA node id.
export interface FolderRenameRow {
  kind: 'folder-rename';
  node_id: string;
  beforeParent: string;
  afterParent: string;
  rows: ModifiedRow[];
}

export type ModifiedEntry = ModifiedRow | FolderRenameRow;

export interface BrowseDiff {
  added: AddedRow[];
  removed: RemovedRow[];
  modified: ModifiedEntry[];
  silentReactivations: string[];
}

interface FlatEntry {
  entry: VariableEntry;
  path: string;
  parentPath: string;
}

function flattenByNodeId(nodes: TreeNode[], prefix: string, out: Map<string, FlatEntry>): void {
  for (const node of nodes) {
    if (isFolder(node)) {
      const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
      flattenByNodeId(node.children, folderPath, out);
    } else if (node.node_id) {
      const path = prefix ? `${prefix}/${node.display_name}` : node.display_name;
      out.set(node.node_id, { entry: node, path, parentPath: prefix });
    }
  }
}

function fieldsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return Object.keys(a ?? {}).length === 0 && Object.keys(b ?? {}).length === 0;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function diffFields(
  before: VariableEntry,
  after: VariableEntry,
  beforeParent: string,
  afterParent: string,
): ChangedField[] {
  const changed: ChangedField[] = [];
  if (before.data_type !== after.data_type) changed.push('data_type');
  if ((before.writable ?? false) !== (after.writable ?? false)) changed.push('writable');
  if (!!before.is_array !== !!after.is_array) changed.push('is_array');
  // array_length is only meaningful when is_array; -1 sentinel distinguishes
  // "absent" (dynamic) from any real fixed length.
  if ((before.array_length ?? -1) !== (after.array_length ?? -1)) changed.push('array_length');
  if (!fieldsEqual(before.fields, after.fields)) changed.push('fields');
  if (before.display_name !== after.display_name) changed.push('display_name');
  if (beforeParent !== afterParent) changed.push('parent_path');
  return changed;
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

// Groups ModifiedRows that share the same old-parent -> new-parent transition
// (2+ leaves) into a single FolderRenameRow, so a folder rename on the server
// is accepted/rejected as one unit instead of leaf-by-leaf.
function groupFolderRenames(modified: ModifiedRow[]): ModifiedEntry[] {
  const bucket = new Map<
    string,
    { beforeParent: string; afterParent: string; rows: ModifiedRow[] }
  >();
  for (const row of modified) {
    if (!row.changedFields.includes('parent_path')) continue;
    const beforeParent = parentOf(row.beforePath);
    const afterParent = parentOf(row.afterPath);
    const key = `${beforeParent}->${afterParent}`;
    let group = bucket.get(key);
    if (!group) {
      group = { beforeParent, afterParent, rows: [] };
      bucket.set(key, group);
    }
    group.rows.push(row);
  }

  const emitted = new Set<string>();
  const result: ModifiedEntry[] = [];
  for (const row of modified) {
    if (!row.changedFields.includes('parent_path')) {
      result.push(row);
      continue;
    }
    const key = `${parentOf(row.beforePath)}->${parentOf(row.afterPath)}`;
    const group = bucket.get(key)!;
    if (group.rows.length < 2) {
      result.push(row);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push({
      kind: 'folder-rename',
      node_id: `folder-rename:${key}`,
      beforeParent: group.beforeParent,
      afterParent: group.afterParent,
      rows: group.rows,
    });
  }
  return result;
}

export function computeBrowseDiff(savedTree: TreeNode[], browseTree: TreeNode[]): BrowseDiff {
  const saved = new Map<string, FlatEntry>();
  const browse = new Map<string, FlatEntry>();
  flattenByNodeId(savedTree, '', saved);
  flattenByNodeId(browseTree, '', browse);

  const added: AddedRow[] = [];
  const removed: RemovedRow[] = [];
  const modified: ModifiedRow[] = [];
  const silentReactivations: string[] = [];

  for (const [nodeId, b] of browse) {
    const s = saved.get(nodeId);
    if (!s) {
      added.push({
        kind: 'added',
        node_id: nodeId,
        path: b.path,
        parentPath: b.parentPath,
        entry: b.entry,
      });
      continue;
    }
    // A previously-stale var that reappears always gets its stale flag cleared,
    // even if metadata also changed and the user later unchecks the Modified row.
    // The var is demonstrably back on the server — the user's choice is about
    // metadata, not server-presence.
    if (s.entry.present_on_server === false) silentReactivations.push(nodeId);
    const changed = diffFields(s.entry, b.entry, s.parentPath, b.parentPath);
    if (changed.length === 0) continue;
    modified.push({
      kind: 'modified',
      node_id: nodeId,
      beforePath: s.path,
      afterPath: b.path,
      before: s.entry,
      after: b.entry,
      changedFields: changed,
    });
  }

  for (const [nodeId, s] of saved) {
    if (browse.has(nodeId)) continue;
    if (s.entry.present_on_server === false) continue;
    removed.push({ kind: 'removed', node_id: nodeId, path: s.path, entry: s.entry });
  }

  return { added, removed, modified: groupFolderRenames(modified), silentReactivations };
}

function cloneTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => (isFolder(n) ? { ...n, children: cloneTree(n.children) } : { ...n }));
}

function findVarByNodeId(nodes: TreeNode[], nodeId: string): VariableEntry | null {
  for (const node of nodes) {
    if (isFolder(node)) {
      const hit = findVarByNodeId(node.children, nodeId);
      if (hit) return hit;
    } else if (node.node_id === nodeId) {
      return node;
    }
  }
  return null;
}

function removeVarByNodeId(nodes: TreeNode[], nodeId: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of nodes) {
    if (isFolder(node)) {
      const children = removeVarByNodeId(node.children, nodeId);
      // Empty folders are pruned. The browse flow only runs against OPC-UA
      // datasources where folders mirror the server hierarchy — so a folder
      // with no remaining children is server state, not a user-authored
      // grouping worth preserving.
      if (children.length > 0) out.push({ ...node, children });
    } else if (node.node_id !== nodeId) {
      out.push(node);
    }
  }
  return out;
}

function ensureParent(nodes: TreeNode[], parentPath: string): TreeNode[] {
  let current = nodes;
  for (const segment of parentPath ? parentPath.split('/') : []) {
    let folder = current.find((n): n is FolderEntry => isFolder(n) && n.name === segment);
    if (!folder) {
      folder = { kind: 'folder', name: segment, children: [] };
      current.push(folder);
    }
    current = folder.children;
  }
  return current;
}

function insertVarAtPath(nodes: TreeNode[], parentPath: string, entry: VariableEntry): TreeNode[] {
  ensureParent(nodes, parentPath).push(entry);
  return nodes;
}

function updateVarMetadata(entry: VariableEntry, after: VariableEntry): void {
  entry.data_type = after.data_type;
  entry.writable = after.writable;
  entry.display_name = after.display_name;
  if (after.is_array) entry.is_array = true;
  else delete entry.is_array;
  if (after.array_length !== undefined) entry.array_length = after.array_length;
  else delete entry.array_length;
  if (after.fields !== undefined) entry.fields = { ...after.fields };
  else delete entry.fields;
  delete entry.present_on_server;
}

interface ApplyParams {
  savedTree: TreeNode[];
  diff: BrowseDiff;
  selected: ReadonlySet<string>;
}

export function diffSelectionKey(kind: 'added' | 'removed' | 'modified', nodeId: string): string {
  return `${kind}:${nodeId}`;
}

function applyModifiedRow(next: TreeNode[], row: ModifiedRow): TreeNode[] {
  let out = removeVarByNodeId(next, row.node_id);
  const inserted: VariableEntry = { ...row.before };
  updateVarMetadata(inserted, row.after);
  const afterParent = parentOf(row.afterPath);
  out = insertVarAtPath(out, afterParent, inserted);
  return out;
}

export function applyBrowseDiff({ savedTree, diff, selected }: ApplyParams): TreeNode[] {
  let next = cloneTree(savedTree);

  for (const row of diff.removed) {
    if (selected.has(diffSelectionKey('removed', row.node_id))) {
      next = removeVarByNodeId(next, row.node_id);
    } else {
      const hit = findVarByNodeId(next, row.node_id);
      if (hit) hit.present_on_server = false;
    }
  }

  for (const row of diff.modified) {
    if (!selected.has(diffSelectionKey('modified', row.node_id))) continue;
    if (row.kind === 'folder-rename') {
      for (const member of row.rows) {
        next = applyModifiedRow(next, member);
      }
      continue;
    }
    const parentChanged = row.changedFields.includes('parent_path');
    if (parentChanged) {
      next = applyModifiedRow(next, row);
    } else {
      const hit = findVarByNodeId(next, row.node_id);
      if (hit) updateVarMetadata(hit, row.after);
    }
  }

  for (const row of diff.added) {
    if (!selected.has(diffSelectionKey('added', row.node_id))) continue;
    // Guard against double-insert: the user may have hand-added a variable
    // with the same node_id between browse and apply.
    if (findVarByNodeId(next, row.node_id)) continue;
    const inserted: VariableEntry = { ...row.entry, enabled: false };
    delete inserted.present_on_server;
    insertVarAtPath(next, row.parentPath, inserted);
  }

  for (const nodeId of diff.silentReactivations) {
    const hit = findVarByNodeId(next, nodeId);
    if (hit) delete hit.present_on_server;
  }

  return next;
}

export function isEmptyDiff(diff: BrowseDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
}
