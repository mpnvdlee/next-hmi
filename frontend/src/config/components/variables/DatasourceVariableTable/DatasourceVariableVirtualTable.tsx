import { useState, type CSSProperties } from 'react';
import type { RefObject } from 'react';
import type { DatasourceType, VariableEntry } from '@shared/types/datasource';
import { FolderRowCells, VariableRowCells, ArrayElementRowCells } from './rowRenderers';
import type { RowItem } from '@config/components/ui/datasourceTreeHelpers';
import VirtualTreeRows from '@config/components/shared/VirtualTreeRows';
import type { VirtualizerRenderLike } from './virtualizerTypes';
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '@config/components/ui/ContextMenu';
import { isArrayShape } from '@shared/types/arrayShape';
import { SearchHighlightProvider } from '@config/components/ui/SearchHighlight';
import { withDotSearchSeparators } from '@shared/utils/search';

interface VirtualTableState {
  scrollRef: RefObject<HTMLDivElement | null>;
  colsTmpl: string;
  showLive: boolean;
  isEditable: boolean;
  rows: RowItem[];
  rowVirtualizer: VirtualizerRenderLike;
  collapsed: Set<string>;
  dsName: string;
  liveValues: Record<string, string>;
  filter: string;
  dsType: DatasourceType;
}

interface VirtualTableActions {
  onToggleFolder: (key: string) => void;
  onSetFolderEnabled: (path: string, nodeId: string | undefined, enabled: boolean) => void;
  onRemoveNode: (path: string) => void;
  onUpdateVar: (path: string, nodeId: string | undefined, patch: Partial<VariableEntry>) => void;
  onAddVariable: (folderPath?: string) => void;
  onAddFolder: (folderPath?: string) => void;
  onAddArray: (folderPath?: string) => void;
  onAddArrayStruct: (folderPath?: string) => void;
  onUpdateArrayLength: (path: string, newLength: number) => void;
  onRenameFolder: (folderPath: string, newName: string) => void;
}

interface Props {
  state: VirtualTableState;
  actions: VirtualTableActions;
}

export default function DatasourceVariableVirtualTable({ state, actions }: Props) {
  const {
    scrollRef,
    colsTmpl,
    showLive,
    isEditable,
    rows,
    rowVirtualizer,
    collapsed,
    dsName,
    liveValues,
    filter,
    dsType,
  } = state;
  const {
    onToggleFolder,
    onSetFolderEnabled,
    onRemoveNode,
    onUpdateVar,
    onAddVariable,
    onAddFolder,
    onAddArray,
    onAddArrayStruct,
    onUpdateArrayLength,
    onRenameFolder,
  } = actions;

  // ── Helpers ─────────────────────────────────────────────────────────────
  /** Returns true when the path is inside a non-first struct array element (e.g. tst6[1]/…). */
  const isInNonFirstElement = (path: string) =>
    path.split('/').some((seg) => /\[\d+\]$/.test(seg) && !/\[0\]$/.test(seg));

  // ── Context menu state ──────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    /** Path of the right-clicked row, or null for empty-area click */
    targetPath: string | null;
    /** If right-clicked on a folder, the folder path for "add inside" */
    folderPath: string | null;
    /** Display name of the folder for context labels */
    folderName: string | null;
    /** Kind of target row */
    kind: 'folder' | 'variable' | 'array-element' | null;
    /** Whether the target is a flat array variable */
    isArray: boolean;
    /** Whether the target is an array-struct folder */
    isArrayStruct: boolean;
  } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isEditable) return;
    e.preventDefault();

    // Walk up DOM to find the row data attributes
    let el = e.target as HTMLElement | null;
    let rowPath: string | null = null;
    let rowKind: 'folder' | 'variable' | 'array-element' | null = null;
    while (el && el !== e.currentTarget) {
      if (el.dataset.rowPath) {
        rowPath = el.dataset.rowPath;
        rowKind = (el.dataset.rowKind as 'folder' | 'variable' | 'array-element') ?? null;
        break;
      }
      el = el.parentElement;
    }

    const folderPath = rowKind === 'folder' ? rowPath : null;
    const folderName = folderPath ? (folderPath.split('/').pop() ?? null) : null;

    // Suppress editing for non-first struct array elements
    if (rowPath && isInNonFirstElement(rowPath)) {
      return;
    }

    // Detect flat array or array-struct from the rows data
    let isArray = false;
    let isArrayStruct = false;
    if (rowPath) {
      const matchedRow = rows.find((r) => r.path === rowPath);
      if (matchedRow) {
        if (matchedRow.kind === 'variable' && isArrayShape(matchedRow.entry)) {
          isArray = true;
        }
        if (matchedRow.kind === 'folder') {
          isArrayStruct = isArrayShape(matchedRow.folder) && matchedRow.folder.children.length > 0;
        }
      }
    }

    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      targetPath: rowPath,
      folderPath,
      folderName,
      kind: rowKind,
      isArray,
      isArrayStruct,
    });
  };

  return (
    <SearchHighlightProvider query={withDotSearchSeparators(filter)}>
      <div
        className="cfg-table-wrap cfg-vtable"
        ref={scrollRef}
        style={{ '--vt-cols': colsTmpl } as CSSProperties}
        onContextMenu={handleContextMenu}
      >
        <div className="cfg-vtable-header">
          <div className="cfg-th cfg-vtable-cell--check">En</div>
          <div className="cfg-th">Display Name</div>
          <div className="cfg-th">Data Type</div>
          <div className="cfg-th">Access</div>
          <div className="cfg-th">Min</div>
          <div className="cfg-th">Max</div>
          {showLive && <div className="cfg-th">Value</div>}
          {isEditable && <div className="cfg-th cfg-th--actions" />}
        </div>

        <VirtualTreeRows
          rows={rows}
          virtualizer={rowVirtualizer}
          getRowClassName={(item) => {
            if (item.kind === 'folder') return 'cfg-vtable-row cfg-var-folder-row';
            if (item.kind === 'array-element')
              return 'cfg-vtable-row cfg-row cfg-row--array-element';
            const cls = ['cfg-vtable-row', 'cfg-row'];
            if (item.entry.enabled) cls.push('cfg-row--enabled');
            if (item.entry.present_on_server === false) cls.push('cfg-row--stale');
            return cls.join(' ');
          }}
          getRowDataAttrs={(item) => ({
            'data-row-path': item.path,
            'data-row-kind': item.kind,
          })}
          renderRow={(item) => {
            const rowEditable = isEditable && !isInNonFirstElement(item.path);
            return item.kind === 'folder' ? (
              <FolderRowCells
                folder={item.folder}
                depth={item.depth}
                path={item.path}
                collapsed={collapsed}
                showLive={showLive}
                isEditable={rowEditable}
                onToggleFolder={onToggleFolder}
                onSetFolderEnabled={onSetFolderEnabled}
                onRemoveNode={onRemoveNode}
                onRenameFolder={onRenameFolder}
              />
            ) : item.kind === 'array-element' ? (
              <ArrayElementRowCells
                parent={item.parent}
                index={item.index}
                depth={item.depth}
                path={item.path}
                dsName={dsName}
                dsType={dsType}
                showLive={showLive}
                isEditable={rowEditable}
              />
            ) : (
              <VariableRowCells
                entry={item.entry}
                depth={item.depth}
                path={item.path}
                dsName={dsName}
                dsType={dsType}
                showLive={showLive}
                isEditable={rowEditable}
                rangeEditable={!isInNonFirstElement(item.path)}
                liveValues={liveValues}
                collapsed={collapsed}
                onToggleArray={onToggleFolder}
                onUpdateVar={onUpdateVar}
                onRemoveNode={onRemoveNode}
              />
            );
          }}
          emptyState={
            <div className="cfg-table-empty">
              {filter
                ? 'No variables match the filter.'
                : isEditable
                  ? 'No variables configured. Right-click to add.'
                  : dsType !== 'static'
                    ? 'No variables configured. Use "Browse PLC" to discover.'
                    : 'No variables configured.'}
            </div>
          }
        />

        {ctxMenu && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
            {ctxMenu.folderPath && (
              <ContextMenuLabel>Add to "{ctxMenu.folderName}"</ContextMenuLabel>
            )}
            {!ctxMenu.folderPath && ctxMenu.targetPath && (
              <ContextMenuLabel>Insert</ContextMenuLabel>
            )}
            {!ctxMenu.folderPath && !ctxMenu.targetPath && (
              <ContextMenuLabel>Add to end</ContextMenuLabel>
            )}
            <ContextMenuItem
              onClick={() => {
                onAddVariable(ctxMenu.folderPath ?? undefined);
                setCtxMenu(null);
              }}
            >
              Variable
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                onAddFolder(ctxMenu.folderPath ?? undefined);
                setCtxMenu(null);
              }}
            >
              Folder
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                onAddArray(ctxMenu.folderPath ?? undefined);
                setCtxMenu(null);
              }}
            >
              Array
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                onAddArrayStruct(ctxMenu.folderPath ?? undefined);
                setCtxMenu(null);
              }}
            >
              Array Struct
            </ContextMenuItem>
            {(ctxMenu.isArray || ctxMenu.isArrayStruct) && ctxMenu.targetPath && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={() => {
                    const newLen = prompt('New array size:', '5');
                    if (newLen !== null) {
                      const n = parseInt(newLen, 10);
                      if (!isNaN(n) && n > 0) {
                        onUpdateArrayLength(ctxMenu.targetPath!, n);
                      }
                    }
                    setCtxMenu(null);
                  }}
                >
                  Change Array Size
                </ContextMenuItem>
              </>
            )}
            {ctxMenu.targetPath && ctxMenu.kind !== 'array-element' && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  danger
                  onClick={() => {
                    onRemoveNode(ctxMenu.targetPath!);
                    setCtxMenu(null);
                  }}
                >
                  Delete
                </ContextMenuItem>
              </>
            )}
          </ContextMenu>
        )}
      </div>
    </SearchHighlightProvider>
  );
}
