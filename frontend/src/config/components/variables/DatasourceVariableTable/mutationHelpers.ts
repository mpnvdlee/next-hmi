import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';
import { isArrayShape } from '@shared/types/arrayShape';

function collectNames(nodes: TreeNode[]): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    if (isFolder(node)) {
      names.add(node.name);
      for (const n of collectNames(node.children)) names.add(n);
    } else {
      names.add(node.display_name);
    }
  }
  return names;
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let i = 1;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * Merge the structure of `template` children into `existing` children.
 * Variables are matched by display_name, folders by name.
 * Fields present in the template but missing from existing are added (copied
 * from the template). Existing values/children are preserved. Fields present
 * in existing but absent from the template are removed so all elements stay
 * structurally identical.
 */
function syncStructChildren(template: TreeNode[], existing: TreeNode[]): TreeNode[] {
  return template.map((tplNode) => {
    if (isFolder(tplNode)) {
      const existingFolder = existing.find(
        (n): n is FolderEntry => isFolder(n) && n.name === tplNode.name,
      );
      const mergedChildren = syncStructChildren(tplNode.children, existingFolder?.children ?? []);
      return { ...tplNode, ...existingFolder, name: tplNode.name, children: mergedChildren };
    } else {
      const existingVar = existing.find(
        (n): n is VariableEntry =>
          !isFolder(n) && n.display_name === (tplNode as VariableEntry).display_name,
      );
      return existingVar ?? tplNode;
    }
  });
}

/**
 * Recursively ensures that any folder whose children are exclusively
 * indexed sub-folders has those children named [0], [1], [2], …
 * in the order they appear. Called after every tree mutation.
 */
export function normalizeArrayStructIndices(tree: TreeNode[]): TreeNode[] {
  return tree.map((node) => {
    if (!isFolder(node)) return node;

    const normalizedChildren = normalizeArrayStructIndices(node.children);

    const subFolders = normalizedChildren.filter(isFolder);
    const hasDirectVars = normalizedChildren.some((c) => !isFolder(c));
    const isIndexedArray =
      !hasDirectVars && subFolders.length > 0 && subFolders.every((f) => /\[\d+\]$/.test(f.name));

    if (!isIndexedArray) {
      return { ...node, children: normalizedChildren };
    }

    // Re-number all indexed sub-folders in sequence, prefixed with the parent name,
    // and sync all children to match the structure of the first element.
    const reindexed = subFolders.map((f, i) => ({ ...f, name: `${node.name}[${i}]` }));
    const first = reindexed[0];
    const synced = reindexed.map((f, i) =>
      i === 0 ? f : { ...f, children: syncStructChildren(first.children, f.children) },
    );
    return { ...node, is_array: true, children: synced };
  });
}

export function appendVariable(tree: TreeNode[], baseName = 'NewVariable'): TreeNode[] {
  const name = uniqueName(baseName, collectNames(tree));
  const base: VariableEntry = {
    kind: 'variable',
    display_name: name,
    data_type: 'Float',
    enabled: true,
    writable: true,
  };

  return [...tree, base];
}

export function appendFolder(tree: TreeNode[], baseName = 'NewFolder'): TreeNode[] {
  const name = uniqueName(baseName, collectNames(tree));
  const folder: FolderEntry = { kind: 'folder', name, children: [] };
  return [...tree, folder];
}

export function appendArray(tree: TreeNode[], baseName = 'NewArray', arrayLength = 5): TreeNode[] {
  const name = uniqueName(baseName, collectNames(tree));
  const base: VariableEntry = {
    kind: 'variable',
    display_name: name,
    data_type: 'Float',
    is_array: true,
    array_length: arrayLength,
    enabled: true,
    writable: true,
  };
  return [...tree, base];
}

export function appendVariableInFolder(tree: TreeNode[], folderPath: string): TreeNode[] {
  return insertInFolder(tree, folderPath, '', (children) => appendVariable(children));
}

export function appendFolderInFolder(tree: TreeNode[], folderPath: string): TreeNode[] {
  return insertInFolder(tree, folderPath, '', (children) => appendFolder(children));
}

export function appendArrayInFolder(tree: TreeNode[], folderPath: string): TreeNode[] {
  return insertInFolder(tree, folderPath, '', (children) => appendArray(children));
}

export function appendArrayStruct(
  tree: TreeNode[],
  baseName = 'NewArrayStruct',
  arrayLength = 3,
): TreeNode[] {
  const name = uniqueName(baseName, collectNames(tree));
  const elements: FolderEntry[] = Array.from({ length: arrayLength }, (_, i) => ({
    kind: 'folder' as const,
    name: `[${i}]`,
    children: [
      {
        kind: 'variable' as const,
        display_name: 'Field1',
        data_type: 'Float',
        enabled: true,
        writable: true,
      } satisfies VariableEntry,
    ],
  }));
  const folder: FolderEntry = { kind: 'folder', name, is_array: true, children: elements };
  return [...tree, folder];
}

export function appendArrayStructInFolder(tree: TreeNode[], folderPath: string): TreeNode[] {
  return insertInFolder(tree, folderPath, '', (children) => appendArrayStruct(children));
}

export function changeArrayLength(tree: TreeNode[], path: string, newLength: number): TreeNode[] {
  const walk = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes.map((node) => {
      if (isFolder(node)) {
        const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
        if (folderPath === path) {
          const subFolders = node.children.filter(isFolder);
          const isIndexed = isArrayShape(node) && subFolders.length > 0;
          if (isIndexed) {
            const currentLen = subFolders.length;
            if (newLength < 0) return node;
            if (newLength <= currentLen) {
              return { ...node, children: subFolders.slice(0, newLength) };
            }
            // Grow: clone template from first element
            const template = subFolders[0].children;
            const extra: FolderEntry[] = Array.from({ length: newLength - currentLen }, (_, i) => ({
              kind: 'folder' as const,
              name: `[${currentLen + i}]`,
              children: structuredClone(template),
            }));
            return { ...node, children: [...subFolders, ...extra] };
          }
        }
        return { ...node, children: walk(node.children, folderPath) };
      }
      const varPath = prefix ? `${prefix}/${node.display_name}` : node.display_name;
      if (varPath === path && isArrayShape(node)) {
        if (newLength > 0) return { ...node, is_array: true, array_length: newLength };
        // 0/negative clears the fixed length, making the array dynamic.
        const { array_length: _dropped, ...rest } = node;
        return { ...rest, is_array: true } as VariableEntry;
      }
      return node;
    });

  return walk(tree, '');
}

function insertInFolder(
  nodes: TreeNode[],
  targetPath: string,
  prefix: string,
  updater: (children: TreeNode[]) => TreeNode[],
): TreeNode[] {
  return nodes.map((node) => {
    if (!isFolder(node)) return node;
    const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
    if (folderPath === targetPath) {
      return { ...node, children: updater(node.children) };
    }
    return { ...node, children: insertInFolder(node.children, targetPath, folderPath, updater) };
  });
}

export function renameFolderInTree(
  tree: TreeNode[],
  folderPath: string,
  newName: string,
): TreeNode[] {
  const walk = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes.map((node) => {
      if (!isFolder(node)) return node;
      const currentPath = prefix ? `${prefix}/${node.name}` : node.name;
      if (currentPath === folderPath) {
        return { ...node, name: newName };
      }
      return { ...node, children: walk(node.children, currentPath) };
    });
  return walk(tree, '');
}

/**
 * Renaming a folder changes the path-chain keys `collapsed` uses for its own
 * key and every descendant's key, so those keys must be migrated alongside
 * the tree mutation above or they go stale (§3.5).
 */
export function renameFolderCollapsedKeys(
  collapsed: Set<string>,
  folderPath: string,
  newName: string,
): Set<string> {
  const segments = folderPath.split('/');
  segments[segments.length - 1] = newName;
  const newFolderPath = segments.join('/');
  if (newFolderPath === folderPath) return collapsed;

  const next = new Set<string>();
  for (const key of collapsed) {
    if (key === folderPath) {
      next.add(newFolderPath);
    } else if (key.startsWith(`${folderPath}/`)) {
      next.add(newFolderPath + key.slice(folderPath.length));
    } else {
      next.add(key);
    }
  }
  return next;
}

export function removeNodeByPath(tree: TreeNode[], path: string): TreeNode[] {
  const walk = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes
      .filter((node) => {
        if (isFolder(node)) {
          const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
          return folderPath !== path;
        }

        const variablePath = prefix ? `${prefix}/${node.display_name}` : node.display_name;
        return variablePath !== path;
      })
      .map((node) => {
        if (isFolder(node)) {
          const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
          return { ...node, children: walk(node.children, folderPath) };
        }
        return node;
      });

  return walk(tree, '');
}

/**
 * Toggle `enabled` for every variable under the folder at `path`. Matching by
 * `(node_id ?? name)` across the whole tree would also flip every other
 * same-named folder (e.g. a nested "Config" folder inside every element of
 * an array-of-struct) — path scoping fixes that (§3.4). `node_id` is
 * preferred when present since it's the globally unique OPC-UA identifier.
 */
export function setFolderEnabledByIdentity(
  tree: TreeNode[],
  path: string,
  nodeId: string | undefined,
  enabled: boolean,
  setEnabledInSubtree: (nodes: TreeNode[], value: boolean) => TreeNode[],
): TreeNode[] {
  const applyToFolder = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes.map((node) => {
      if (!isFolder(node)) return node;
      const folderPath = prefix ? `${prefix}/${node.name}` : node.name;
      const match = nodeId ? node.node_id === nodeId : folderPath === path;
      if (match) {
        return { ...node, children: setEnabledInSubtree(node.children, enabled) };
      }
      return { ...node, children: applyToFolder(node.children, folderPath) };
    });

  return applyToFolder(tree, '');
}
