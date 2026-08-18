import type { StructSchemaNode } from '@shared/types/componentProperty';

/** Split a slash-delimited index path into numeric indices. */
export function parsePath(path: string): number[] {
  return path.split('/').map(Number);
}

/** Return the node at the given index path (or null if not found). */
export function getNodeAt(nodes: StructSchemaNode[], path: number[]): StructSchemaNode | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  const node = nodes[head];
  if (!node) return null;
  if (rest.length === 0) return node;
  if (!node.children) return null;
  return getNodeAt(node.children, rest);
}

/**
 * Immutably append a new node to the children of the folder at `folderPath`.
 * If folderPath is null, append to the root.
 */
export function appendNode(
  nodes: StructSchemaNode[],
  folderPath: string | null,
  newNode: StructSchemaNode,
): StructSchemaNode[] {
  if (folderPath === null) {
    return [...nodes, newNode];
  }
  const indices = parsePath(folderPath);
  return updateNodeChildren(nodes, indices, (children) => [...children, newNode]);
}

function updateNodeChildren(
  nodes: StructSchemaNode[],
  indices: number[],
  updater: (children: StructSchemaNode[]) => StructSchemaNode[],
): StructSchemaNode[] {
  const [head, ...rest] = indices;
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) {
      return { ...node, children: updater(node.children ?? []) };
    }
    return {
      ...node,
      children: updateNodeChildren(node.children ?? [], rest, updater),
    };
  });
}

/** Immutably remove the node at the given path. */
export function removeNode(nodes: StructSchemaNode[], path: string): StructSchemaNode[] {
  return removeNodeAt(nodes, parsePath(path));
}

function removeNodeAt(nodes: StructSchemaNode[], indices: number[]): StructSchemaNode[] {
  const [head, ...rest] = indices;
  if (rest.length === 0) {
    return nodes.filter((_, i) => i !== head);
  }
  return nodes.map((node, i) => {
    if (i !== head) return node;
    return { ...node, children: removeNodeAt(node.children ?? [], rest) };
  });
}

/** Immutably patch the node at the given path. */
export function patchNode(
  nodes: StructSchemaNode[],
  path: string,
  patch: Partial<StructSchemaNode>,
): StructSchemaNode[] {
  return patchNodeAt(nodes, parsePath(path), patch);
}

function patchNodeAt(
  nodes: StructSchemaNode[],
  indices: number[],
  patch: Partial<StructSchemaNode>,
): StructSchemaNode[] {
  const [head, ...rest] = indices;
  return nodes.map((node, i) => {
    if (i !== head) return node;
    if (rest.length === 0) return { ...node, ...patch };
    return { ...node, children: patchNodeAt(node.children ?? [], rest, patch) };
  });
}

export function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 1;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export interface FlatRow {
  /** e.g. "0", "0/1", "0/1/2" */
  path: string;
  depth: number;
  node: StructSchemaNode;
  parentFolderPath: string | null;
}

export function flattenTree(
  nodes: StructSchemaNode[],
  collapsed: Set<string>,
  depth = 0,
  parentPath: string | null = null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const path = parentPath === null ? String(i) : `${parentPath}/${i}`;
    rows.push({ path, depth, node, parentFolderPath: parentPath });
    const isFolder = node.kind === 'folder';
    if (isFolder && node.children && !collapsed.has(path)) {
      rows.push(...flattenTree(node.children, collapsed, depth + 1, path));
    }
  }
  return rows;
}
