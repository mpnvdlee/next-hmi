import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { TreeNode } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import type { BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import ModalShell, { ModalCloseButton } from '@config/components/ui/ModalShell';
import Button from '@config/components/ui/Button';
import {
  browseTopLevel,
  isBrowseLeaf,
  newLeafIds,
  nodeKey,
  savedNodeIds,
  withBrowseChildren,
} from './browseMerge';

type BrowseMode = 'marked' | 'lazy' | 'all';

type BrowseResult = BrowseNode & { show_root?: boolean; browse_mode?: BrowseMode };

interface Props {
  dsName: string;
  /** The variable tree as it is now: what is saved already shows as added. */
  savedTree: TreeNode[];
  /** `browse_attributes` of the datasource, for the empty marked-browse message. */
  attributes?: string;
  onImport: (browseNodes: BrowseNode[], selected: ReadonlySet<string>) => void;
  onClose: () => void;
}

function browseUrl(dsName: string, nodeId?: string): string {
  const base = `/api/datasources/${encodeURIComponent(dsName)}/browse`;
  return nodeId ? `${base}?node_id=${encodeURIComponent(nodeId)}` : base;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function folderIds(nodes: BrowseNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (!isBrowseLeaf(node)) {
      out.push(node.node_id);
      folderIds(node.children ?? [], out);
    }
  }
  return out;
}

/** The folders a browse root was split into (`browseTopLevel`), down to and
 *  including the root itself — what opens first, so its level shows. */
function rootPathIds(top: BrowseNode[], rootId: string): string[] {
  const ids: string[] = [];
  let node: BrowseNode | undefined = top[0];
  while (node) {
    ids.push(node.node_id);
    if (node.node_id === rootId) break;
    node = node.children?.[0];
  }
  return ids;
}

/**
 * Browse an ADS PLC and tick variables to add (`mergeBrowseSelection`).
 *
 * A marked or full browse arrives as one tree; a lazy one level at a time, a
 * folder or struct loading its own level when first expanded. Saved variables
 * show as added and cannot be ticked again.
 */
export default function AdsBrowseDialog({
  dsName,
  savedTree,
  attributes,
  onImport,
  onClose,
}: Props) {
  const [nodes, setNodes] = useState<BrowseNode[] | null>(null);
  const [mode, setMode] = useState<BrowseMode>('marked');
  // What the browse itself returned, below any root folders added around it.
  const [found, setFound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Lazy levels fetched already — an empty struct stays fetched.
  const loaded = useRef(new Set<string>());
  const abort = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    apiJson<BrowseResult>(browseUrl(dsName), { signal: controller.signal })
      .then((root) => {
        const top = browseTopLevel(root);
        const browseMode = root.browse_mode ?? 'marked';
        setMode(browseMode);
        setFound(root.children?.length ?? 0);
        setNodes(top);
        // A marked tree is small by design: open it all. A lazy or full one
        // opens only the root's own folders; the root's level is loaded.
        if (browseMode === 'marked') setExpanded(new Set(folderIds(top)));
        else if (root.show_root) {
          loaded.current.add(root.node_id);
          setExpanded(new Set(rootPathIds(top, root.node_id)));
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err));
      });
    return () => controller.abort();
  }, [dsName]);

  const saved = useMemo(() => savedNodeIds(savedTree), [savedTree]);
  const allNew = useMemo(() => newLeafIds(nodes ?? [], saved), [nodes, saved]);

  async function loadLevel(nodeId: string) {
    setLoading((prev) => new Set(prev).add(nodeId));
    try {
      const level = await apiJson<BrowseResult>(browseUrl(dsName, nodeId), {
        signal: abort.current.signal,
      });
      loaded.current.add(nodeId);
      setNodes((prev) => prev && withBrowseChildren(prev, nodeId, level.children ?? []));
    } catch (err) {
      if (!abort.current.signal.aborted) setError(errorText(err));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    }
  }

  function toggleOpen(node: BrowseNode) {
    const open = expanded.has(node.node_id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(node.node_id);
      else next.add(node.node_id);
      return next;
    });
    if (!open && node.has_children && !node.children?.length && !loaded.current.has(node.node_id)) {
      void loadLevel(node.node_id);
    }
  }

  function setTicked(ids: string[], ticked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (ticked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function renderNodes(list: BrowseNode[], depth: number) {
    return list.map((node) => {
      if (isBrowseLeaf(node)) {
        const added = saved.has(nodeKey(node.node_id));
        return (
          <label
            key={node.node_id}
            className={`cfg-ads-browse__row${added ? ' cfg-ads-browse__row--added' : ''}`}
            style={{ '--cfg-ads-browse-depth': depth } as CSSProperties}
            title={node.node_id}
          >
            <span className="cfg-ads-browse__caret" />
            <input
              type="checkbox"
              checked={added || selected.has(node.node_id)}
              disabled={added}
              onChange={(e) => setTicked([node.node_id], e.target.checked)}
            />
            <span className="cfg-ads-browse__name">{node.display_name}</span>
            <span className="cfg-ads-browse__type">
              {node.data_type}
              {node.is_array ? `[${node.array_length ?? ''}]` : ''}
            </span>
            {added && <span className="cfg-ads-browse__tag">added</span>}
          </label>
        );
      }
      const open = expanded.has(node.node_id);
      const below = newLeafIds(node.children ?? [], saved);
      const allTicked = below.length > 0 && below.every((id) => selected.has(id));
      return (
        <div key={node.node_id} role="group" aria-label={node.display_name}>
          <div
            className="cfg-ads-browse__row cfg-ads-browse__row--folder"
            style={{ '--cfg-ads-browse-depth': depth } as CSSProperties}
            title={node.node_id}
          >
            <button
              type="button"
              className="cfg-ads-browse__caret"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${node.display_name}`}
              onClick={() => toggleOpen(node)}
            >
              {open ? '▾' : '▸'}
            </button>
            <input
              type="checkbox"
              aria-label={`Select new variables in ${node.display_name}`}
              checked={allTicked}
              disabled={below.length === 0}
              onChange={(e) => setTicked(below, e.target.checked)}
            />
            <span className="cfg-ads-browse__name">{node.display_name}</span>
            {node.data_type === 'struct' && (
              <span className="cfg-ads-browse__type">{node.is_array ? 'struct[]' : 'struct'}</span>
            )}
            {loading.has(node.node_id) && <span className="cfg-ads-browse__tag">loading…</span>}
          </div>
          {open && renderNodes(node.children ?? [], depth + 1)}
        </div>
      );
    });
  }

  const attribute = attributes?.split(',')[0]?.trim() || 'OPC.UA.DA';
  const selectedNew = allNew.filter((id) => selected.has(id)).length;

  return (
    <ModalShell onClose={onClose} dialogClassName="cfg-ads-browse">
      <header className="cfg-modal-header">
        <h2 className="cfg-ads-browse__title">Browse PLC — {dsName}</h2>
        <ModalCloseButton onClose={onClose} />
      </header>

      <div className="cfg-ads-browse__body">
        {error && <div className="cfg-error-banner">{error}</div>}
        {!error && nodes === null && <p className="cfg-ads-browse__note">Browsing the PLC…</p>}
        {nodes !== null && found === 0 && (
          <p className="cfg-ads-browse__note" role="status">
            {mode === 'marked' ? (
              <>
                Nothing on the PLC carries <code>{`{attribute '${attribute}' := '1'}`}</code>, so a
                marked browse finds no variables. Add that attribute to the variables to show, or in
                this datasource’s Advanced settings set Browse Mode to Lazy (one level) or change
                Browse Attributes.
              </>
            ) : (
              'The PLC has no variables to show here.'
            )}
          </p>
        )}
        {nodes !== null && found > 0 && (
          <>
            {mode !== 'lazy' && allNew.length === 0 && (
              <p className="cfg-ads-browse__note" role="status">
                Every variable this browse found is already in this datasource.
              </p>
            )}
            <p className="cfg-ads-browse__note">
              Tick variables to add. Variables already in this datasource show as added; nothing
              saved is changed or removed. A member ticked in one element of a struct array is added
              for every element. Struct-array elements are numbered from 0 in the table and in
              bindings, as for OPC-UA: aPoints[1] on the PLC is aPoints[0] there.
            </p>
            <div className="cfg-ads-browse__tree">{renderNodes(nodes, 0)}</div>
          </>
        )}
      </div>

      <footer className="cfg-ads-browse__footer">
        <div className="cfg-ads-browse__footer-left">
          <Button
            variant="ghost"
            size="sm"
            disabled={allNew.length === 0}
            onClick={() => setTicked(allNew, true)}
          >
            Select all new
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            Select none
          </Button>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={selectedNew === 0}
          onClick={() => {
            onImport(nodes ?? [], selected);
            onClose();
          }}
        >
          {selectedNew === 0
            ? 'Add variables'
            : selectedNew === 1
              ? 'Add 1 variable'
              : `Add ${selectedNew} variables`}
        </Button>
      </footer>
    </ModalShell>
  );
}
