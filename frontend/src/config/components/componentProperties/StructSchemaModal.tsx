import { useState, useRef, useCallback, type CSSProperties } from 'react';
import { ClearIcon } from '@config/components/ui/actionIcons';
import '../variables/DatasourceVariableTable/style.css';
import './componentProperty.css';
import { type StructSchemaNode } from '@shared/types/componentProperty';
import { VALUE_TYPES } from '@shared/utils/valueTypes';
import { useToggleSet } from '@shared/hooks/useToggleSet';
import ModalShell, { ModalCloseButton } from '../ui/ModalShell';
import { PickerTitle } from '../ui/PickerDrawerHeader';
import PickerFooter from '../ui/PickerFooter';
import InlineTextEdit from '../ui/InlineTextEdit';
import Select from '../ui/Select';
import BoolButtonGroup from '../ui/BoolButtonGroup';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '../ui/ContextMenu';
import { treePaddingLeft, treePaddingLeftWithOffset } from '@config/utils/treeRowLayout';
import {
  appendNode,
  flattenTree,
  getNodeAt,
  parsePath,
  patchNode,
  removeNode,
  uniqueName,
  type FlatRow,
} from './structTreeMutations';

function VariableRow({
  row,
  onPatch,
  onDelete,
}: {
  row: FlatRow;
  onPatch: (patch: Partial<StructSchemaNode>) => void;
  onDelete: () => void;
}) {
  const { node, depth, path } = row;

  return (
    <div
      className="cfg-vtable-row cfg-row cfg-row--enabled"
      data-row-path={path}
      data-row-kind="variable"
      data-row-parent={row.parentFolderPath ?? ''}
    >
      <div className="cfg-vtable-cell cfg-vtable-cell--flush">
        <div
          className="cfg-var-name-cell"
          style={
            { '--row-indent': treePaddingLeftWithOffset(depth, '18px + 0.2rem') } as CSSProperties
          }
        >
          <InlineTextEdit
            as="span"
            value={node.name}
            onCommit={(name) => onPatch({ name })}
            title="Double-click to rename"
            emptyDisplay={<span className="struct-schema-row__unnamed">unnamed</span>}
            stopKeyPropagation
          />
        </div>
      </div>

      <div className="cfg-vtable-cell">
        <Select
          className="cfg-select--ghost"
          value={node.type ?? 'Boolean'}
          onChange={(v) => onPatch({ type: v })}
          onClick={(e) => e.stopPropagation()}
        >
          {VALUE_TYPES.map((dt) => (
            <option key={dt} value={dt}>
              {dt}
            </option>
          ))}
        </Select>
      </div>

      <div
        className="cfg-vtable-cell cfg-vtable-cell--check"
        onClick={(e) => e.stopPropagation()}
        title="Requires write access"
      >
        <BoolButtonGroup value={node.write ?? false} onChange={(write) => onPatch({ write })} />
      </div>

      <div className="cfg-vtable-cell cfg-vtable-cell--actions">
        <button
          className="cfg-row-action-btn"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <ClearIcon />
        </button>
      </div>
    </div>
  );
}

function FolderRow({
  row,
  collapsed,
  childCount,
  onToggle,
  onPatch,
  onDelete,
}: {
  row: FlatRow;
  collapsed: boolean;
  childCount: number;
  onToggle: () => void;
  onPatch: (patch: Partial<StructSchemaNode>) => void;
  onDelete: () => void;
}) {
  const { node, depth, path } = row;

  return (
    <div
      className="cfg-vtable-row cfg-var-folder-row"
      data-row-path={path}
      data-row-kind="folder"
      data-row-parent={row.parentFolderPath ?? ''}
    >
      <div className="cfg-vtable-cell cfg-vtable-cell--flush">
        <button
          className="cfg-var-folder-btn"
          style={{ '--row-indent': treePaddingLeft(depth) } as CSSProperties}
          onClick={onToggle}
        >
          <span className="cfg-var-folder-arrow">{collapsed ? '▶' : '▼'}</span>
          <InlineTextEdit
            as="span"
            value={node.name}
            onCommit={(name) => onPatch({ name })}
            title="Double-click to rename"
            emptyDisplay={<span className="struct-schema-row__unnamed">unnamed</span>}
            stopKeyPropagation
          />
          <span className="cfg-var-folder-count">{childCount}</span>
        </button>
      </div>

      <div className="cfg-vtable-cell">
        <span className="struct-schema-row__kind">folder</span>
      </div>

      <div className="cfg-vtable-cell cfg-vtable-cell--check" />

      <div className="cfg-vtable-cell cfg-vtable-cell--actions">
        <button
          className="cfg-row-action-btn"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <ClearIcon />
        </button>
      </div>
    </div>
  );
}

function ArrayRow({
  row,
  onPatch,
  onDelete,
}: {
  row: FlatRow;
  onPatch: (patch: Partial<StructSchemaNode>) => void;
  onDelete: () => void;
}) {
  const { node, depth, path } = row;

  return (
    <div
      className="cfg-vtable-row cfg-row cfg-row--enabled"
      data-row-path={path}
      data-row-kind="array"
      data-row-parent={row.parentFolderPath ?? ''}
    >
      <div className="cfg-vtable-cell cfg-vtable-cell--flush">
        <div
          className="cfg-var-name-cell"
          style={
            { '--row-indent': treePaddingLeftWithOffset(depth, '18px + 0.2rem') } as CSSProperties
          }
        >
          <InlineTextEdit
            as="span"
            value={node.name}
            onCommit={(name) => onPatch({ name })}
            title="Double-click to rename"
            emptyDisplay={<span className="struct-schema-row__unnamed">unnamed</span>}
            stopKeyPropagation
          />
        </div>
      </div>

      <div className="cfg-vtable-cell">
        <Select
          className="cfg-select--ghost"
          value={node.type ?? 'Boolean'}
          onChange={(v) => onPatch({ type: v })}
          onClick={(e) => e.stopPropagation()}
        >
          {VALUE_TYPES.map((dt) => (
            <option key={dt} value={dt}>
              {dt}
            </option>
          ))}
        </Select>
        <span className="struct-schema-table__array-badge">[ ]</span>
      </div>

      <div className="cfg-vtable-cell cfg-vtable-cell--check" />

      <div className="cfg-vtable-cell cfg-vtable-cell--actions">
        <button
          className="cfg-row-action-btn"
          title="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <ClearIcon />
        </button>
      </div>
    </div>
  );
}

interface Props {
  propKey: string;
  initialSchema: StructSchemaNode[];
  onConfirm(schema: StructSchemaNode[]): void;
  onCancel(): void;
}

interface CtxMenuState {
  x: number;
  y: number;
  targetPath: string | null;
  folderPath: string | null;
  folderName: string | null;
  kind: 'folder' | 'variable' | 'array' | null;
}

export function StructSchemaModal({ propKey, initialSchema, onConfirm, onCancel }: Props) {
  const [draft, setDraft] = useState<StructSchemaNode[]>(initialSchema);
  const [collapsed, toggleFolder, setCollapsed] = useToggleSet<string>();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const rows = flattenTree(draft, collapsed);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      let el: HTMLElement | null = e.target as HTMLElement;
      let targetPath: string | null = null;
      let kind: 'folder' | 'variable' | 'array' | null = null;
      let folderPath: string | null = null;
      let folderName: string | null = null;
      let parentPath: string | null = null;

      while (el && el !== tableRef.current) {
        const p = el.dataset.rowPath;
        const k = el.dataset.rowKind;
        const parent = el.dataset.rowParent;
        if (p !== undefined && k) {
          targetPath = p;
          kind = k as 'folder' | 'variable' | 'array';
          parentPath = parent ?? null;
          break;
        }
        el = el.parentElement;
      }

      if (kind === 'folder' && targetPath !== null) {
        const node = getNodeAt(draft, parsePath(targetPath));
        folderPath = targetPath;
        folderName = node?.name ?? null;
      } else if (parentPath !== null && parentPath !== '') {
        const parentNode = getNodeAt(draft, parsePath(parentPath));
        if (parentNode?.kind === 'folder') {
          folderPath = parentPath;
          folderName = parentNode.name;
        }
      }

      setCtxMenu({ x: e.clientX, y: e.clientY, targetPath, folderPath, folderName, kind });
    },
    [draft],
  );

  function addNode(kind: StructSchemaNode['kind'], intoFolder: string | null = null) {
    const folderPath = intoFolder ?? ctxMenu?.folderPath ?? null;
    const containerLevel =
      folderPath !== null ? (getNodeAt(draft, parsePath(folderPath))?.children ?? []) : draft;
    const siblings = new Set(containerLevel.map((n) => n.name));
    const baseName = kind === 'folder' ? 'Folder' : kind === 'array' ? 'Array' : 'Field';
    const name = uniqueName(baseName, siblings);

    const newNode: StructSchemaNode =
      kind === 'folder'
        ? { kind: 'folder', name, children: [] }
        : kind === 'array'
          ? { kind: 'array', name, type: 'Float' }
          : { kind: 'variable', name, type: 'Boolean', write: false };

    setDraft((prev) => appendNode(prev, folderPath, newNode));
    if (folderPath !== null) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(folderPath);
        return next;
      });
    }
    setCtxMenu(null);
  }

  function deleteNode(path: string) {
    setDraft((prev) => removeNode(prev, path));
    setCtxMenu(null);
  }

  return (
    <ModalShell
      onClose={onCancel}
      overlayClassName="cfg-picker-drawer-overlay"
      dialogClassName="cfg-drawer cfg-drawer--md struct-schema-popup"
    >
      <div className="cfg-modal-header struct-schema-popup__header">
        <PickerTitle context={propKey} action="Edit schema" />
        <ModalCloseButton onClose={onCancel} />
      </div>

      <div className="struct-schema-popup__toolbar">
        <p className="struct-schema-popup__hint">
          Define the OPC-UA field structure this property must match. Double-click a name to rename;
          right-click a row to add inside a folder or delete.
        </p>
        <Select
          className="struct-schema-popup__add"
          value=""
          onChange={(kind) => {
            if (kind) addNode(kind as StructSchemaNode['kind'], null);
          }}
        >
          <option value="">Add</option>
          <option value="variable">Variable</option>
          <option value="folder">Folder</option>
          <option value="array">Array</option>
        </Select>
      </div>

      <div
        ref={tableRef}
        className="struct-schema-table cfg-vtable"
        onContextMenu={handleContextMenu}
      >
        <div className="cfg-vtable-header">
          <div className="cfg-th">Name</div>
          <div className="cfg-th">Data Type</div>
          <div className="cfg-th">Write</div>
          <div className="cfg-th" />
        </div>

        {rows.length === 0 ? (
          <div className="cfg-table-empty">No fields yet — use Add above, or right-click here.</div>
        ) : (
          rows.map((row) => {
            if (row.node.kind === 'folder') {
              return (
                <FolderRow
                  key={row.path}
                  row={row}
                  collapsed={collapsed.has(row.path)}
                  childCount={row.node.children?.length ?? 0}
                  onToggle={() => toggleFolder(row.path)}
                  onPatch={(patch) => setDraft((prev) => patchNode(prev, row.path, patch))}
                  onDelete={() => deleteNode(row.path)}
                />
              );
            }
            if (row.node.kind === 'array') {
              return (
                <ArrayRow
                  key={row.path}
                  row={row}
                  onPatch={(patch) => setDraft((prev) => patchNode(prev, row.path, patch))}
                  onDelete={() => deleteNode(row.path)}
                />
              );
            }
            return (
              <VariableRow
                key={row.path}
                row={row}
                onPatch={(patch) => setDraft((prev) => patchNode(prev, row.path, patch))}
                onDelete={() => deleteNode(row.path)}
              />
            );
          })
        )}
      </div>

      <PickerFooter onCancel={onCancel} onConfirm={() => onConfirm(draft)} confirmLabel="Save" />

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <ContextMenuLabel>
            {ctxMenu.folderName ? `Add to "${ctxMenu.folderName}"` : 'Add to schema'}
          </ContextMenuLabel>
          <ContextMenuItem onClick={() => addNode('variable')}>Variable</ContextMenuItem>
          <ContextMenuItem onClick={() => addNode('folder')}>Folder</ContextMenuItem>
          <ContextMenuItem onClick={() => addNode('array')}>Array</ContextMenuItem>
          {ctxMenu.targetPath !== null && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem danger onClick={() => deleteNode(ctxMenu.targetPath!)}>
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </ModalShell>
  );
}
