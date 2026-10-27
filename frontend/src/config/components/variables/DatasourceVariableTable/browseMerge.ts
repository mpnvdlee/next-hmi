/**
 * Add-only browse import, for a datasource whose browse returns part of the
 * address space at a time (ADS: a lazily expanded level, or only the marked
 * variables). Unlike `computeBrowseDiff` / `applyBrowseDiff`, which reconcile
 * the saved tree with one complete browse, nothing here modifies or removes a
 * saved variable: ticked browse nodes are added beside them, under the
 * folders their PLC path names. Whether a saved variable still exists is a
 * separate question — `applyPlcCheck`.
 */

import { buildFromBrowse, type BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import { isFolder, type FolderEntry, type TreeNode } from '@shared/types/datasource';
import { cloneTree, type RemovedRow } from './datasourceBrowseDiff';

/** A browse node that imports as a variable. A struct imports as the folder
 *  of its members (see `buildFromBrowse`), so it is never ticked itself. */
export function isBrowseLeaf(node: BrowseNode): boolean {
  return node.data_type != null && node.data_type !== 'struct';
}

/** An array of structs: its children are the `[n]` element nodes. */
function isStructArray(node: BrowseNode): boolean {
  return !isBrowseLeaf(node) && node.is_array === true;
}

// One name or index of a PLC member path, as `ads.symbols` splits one.
const PATH_TOKEN = /\.?[^.[\]]+|\[[^\]]*\]/g;

/**
 * The top-level nodes of a browse result. A browse from a root (the
 * `browse_root` setting) names it with its whole member path; that is split
 * into one folder per segment, so what is imported from it lands under the
 * same folders as a browse of the whole program would put it.
 */
export function browseTopLevel(root: BrowseNode & { show_root?: boolean }): BrowseNode[] {
  if (!root.show_root) return root.children ?? [];
  const tokens = root.node_id.match(PATH_TOKEN) ?? [root.node_id];
  // A leading dot belongs to the first name (`.TCPADS_MAXUDP_BUFFSIZE`).
  const name = (i: number) => (i > 0 && tokens[i].startsWith('.') ? tokens[i].slice(1) : tokens[i]);
  let node: BrowseNode = {
    node_id: root.node_id,
    display_name: name(tokens.length - 1),
    data_type: null,
    children: root.children ?? [],
  };
  for (let i = tokens.length - 2; i >= 0; i--) {
    node = {
      node_id: tokens.slice(0, i + 1).join(''),
      display_name: name(i),
      data_type: null,
      children: [node],
    };
  }
  return [node];
}

/** `nodes` with the children of `nodeId` replaced — a lazily expanded level. */
export function withBrowseChildren(
  nodes: BrowseNode[],
  nodeId: string,
  children: BrowseNode[],
): BrowseNode[] {
  return nodes.map((node) =>
    node.node_id === nodeId
      ? { ...node, children }
      : node.children?.length
        ? { ...node, children: withBrowseChildren(node.children, nodeId, children) }
        : node,
  );
}

/** A node id as compared here: ADS member paths are case-insensitive, so a
 *  path saved as `MAIN.stLine` is the same variable as `main.stline`. */
export function nodeKey(nodeId: string): string {
  return nodeId.toLowerCase();
}

/** The node ids (as `nodeKey`s) of the variables saved in `tree`. */
export function savedNodeIds(tree: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const node of tree) {
    if (isFolder(node)) savedNodeIds(node.children, out);
    else if (node.node_id) out.add(nodeKey(node.node_id));
  }
  return out;
}

/** The node ids of the leaves below `nodes` (loaded so far) that are not in `saved`. */
export function newLeafIds(nodes: BrowseNode[], saved: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (isBrowseLeaf(node)) {
      if (!saved.has(nodeKey(node.node_id))) out.push(node.node_id);
    } else {
      out.push(...newLeafIds(node.children ?? [], saved));
    }
  }
  return out;
}

function rebase(node: BrowseNode, from: string, to: string): BrowseNode {
  return {
    ...node,
    node_id: to + node.node_id.slice(from.length),
    children: node.children?.map((child) => rebase(child, from, to)),
  };
}

function unionNodes(a: BrowseNode[], b: BrowseNode[]): BrowseNode[] {
  const out = [...a];
  for (const node of b) {
    const at = out.findIndex((n) => nodeKey(n.node_id) === nodeKey(node.node_id));
    if (at < 0) out.push(node);
    else if (!isBrowseLeaf(node))
      out[at] = { ...out[at], children: unionNodes(out[at].children ?? [], node.children ?? []) };
  }
  return out;
}

/**
 * The browse nodes that lead to a ticked leaf, and nothing else.
 *
 * Every element of a struct array must hold the same members — the variable
 * tree keeps them in step (`normalizeArrayStructIndices`) — so a member ticked
 * in one element is picked in every element. The elements share one layout, so
 * each copy is the ticked node with its element's path, even for an element a
 * lazy browse has not expanded.
 */
export function pickBrowseSelection(
  nodes: BrowseNode[],
  selected: ReadonlySet<string>,
): BrowseNode[] {
  const out: BrowseNode[] = [];
  for (const node of nodes) {
    if (isBrowseLeaf(node)) {
      if (selected.has(node.node_id)) out.push(node);
      continue;
    }
    const elements = node.children ?? [];
    if (isStructArray(node)) {
      let members: BrowseNode[] = [];
      for (const element of elements) {
        const picked = pickBrowseSelection(element.children ?? [], selected);
        members = unionNodes(
          members,
          picked.map((m) => rebase(m, element.node_id, '')),
        );
      }
      if (members.length > 0) {
        out.push({
          ...node,
          children: elements.map((element) => ({
            ...element,
            children: members.map((m) => rebase(m, '', element.node_id)),
          })),
        });
      }
      continue;
    }
    const children = pickBrowseSelection(elements, selected);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}

function mergeInto(target: TreeNode[], incoming: TreeNode[], saved: ReadonlySet<string>): void {
  for (const node of incoming) {
    if (!isFolder(node)) {
      if (!node.node_id || !saved.has(nodeKey(node.node_id))) target.push(node);
      continue;
    }
    // By node id where both have one: the tree renames struct-array elements
    // (`[1]` → `aPoints[0]`), so an element's name is not its PLC index.
    const existing = target.find(
      (n): n is FolderEntry =>
        isFolder(n) &&
        (n.node_id && node.node_id
          ? nodeKey(n.node_id) === nodeKey(node.node_id)
          : n.name === node.name),
    );
    if (existing) {
      mergeInto(existing.children, node.children, saved);
      continue;
    }
    const created: FolderEntry = { ...node, children: [] };
    mergeInto(created.children, node.children, saved);
    if (created.children.length > 0) target.push(created);
  }
}

/**
 * `savedTree` plus the ticked browse leaves that are not saved yet (matched by
 * node id), each under the folder / struct-folder path of its PLC path,
 * creating the folders it needs. New variables start disabled, as from the
 * OPC-UA import; saved variables and folders are left as they are.
 */
export function mergeBrowseSelection(
  savedTree: TreeNode[],
  browseNodes: BrowseNode[],
  selected: ReadonlySet<string>,
): TreeNode[] {
  const incoming = buildFromBrowse(pickBrowseSelection(browseNodes, selected), new Map());
  const next = cloneTree(savedTree);
  mergeInto(next, incoming, savedNodeIds(savedTree));
  return next;
}

function checkedNode(node: TreeNode, missing: ReadonlySet<string>): TreeNode {
  if (isFolder(node)) {
    const children = applyPlcCheck(node.children, missing);
    return children === node.children ? node : { ...node, children };
  }
  if (node.node_id && missing.has(node.node_id)) {
    return node.present_on_server === false ? node : { ...node, present_on_server: false };
  }
  if (node.present_on_server !== false) return node;
  const { present_on_server: _present, ...rest } = node;
  return rest;
}

/**
 * `tree` with every variable whose node id is in `missing` marked stale
 * (`present_on_server: false`) and the mark cleared on every other one.
 * Nothing is added or removed; the same array comes back when nothing changed.
 */
export function applyPlcCheck(tree: TreeNode[], missing: ReadonlySet<string>): TreeNode[] {
  let changed = false;
  const next = tree.map((node) => {
    const checked = checkedNode(node, missing);
    if (checked !== node) changed = true;
    return checked;
  });
  return changed ? next : tree;
}

/** The stale variables of `tree`, as the browse banner's removal rows. */
export function staleRows(tree: TreeNode[], prefix = ''): RemovedRow[] {
  const rows: RemovedRow[] = [];
  for (const node of tree) {
    if (isFolder(node)) {
      rows.push(...staleRows(node.children, prefix ? `${prefix}/${node.name}` : node.name));
    } else if (node.node_id && node.present_on_server === false) {
      const path = prefix ? `${prefix}/${node.display_name}` : node.display_name;
      rows.push({ kind: 'removed', node_id: node.node_id, path, entry: node });
    }
  }
  return rows;
}
