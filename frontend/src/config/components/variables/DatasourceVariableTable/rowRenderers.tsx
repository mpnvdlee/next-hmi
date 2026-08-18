import { useState, useRef, useEffect, useMemo, memo, type CSSProperties } from 'react';
import {
  buildVarKey,
  isFolder,
  DATASOURCE_CAPABILITIES,
  type DatasourceType,
  type FolderEntry,
  type VariableEntry,
} from '@shared/types/datasource';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import AccessBadge from '@config/components/ui/AccessBadge';
import LiveValue from '@config/components/ui/LiveValue';
import Select from '@config/components/ui/Select';
import InlineTextEdit from '@config/components/ui/InlineTextEdit';
import { countEnabledVars, countVars } from '@config/components/ui/datasourceTreeHelpers';
import { treePaddingLeft, treePaddingLeftWithOffset } from '@config/utils/treeRowLayout';
import {
  VALUE_TYPES,
  OPCUA_TYPES,
  toSimpleType,
  representativeOpcuaType,
  canonicalOpcuaType,
  isNumericType,
} from '@shared/utils/valueTypes';
import { arrayBadgeSuffix, isArrayShape } from '@shared/types/arrayShape';
import SearchHighlight from '@config/components/ui/SearchHighlight';

function DualType({ dataType, arrayBadge }: { dataType?: string; arrayBadge?: string }) {
  return (
    <span className="cfg-var-type-dual">
      <span className="cfg-var-type-local">
        <SearchHighlight text={toSimpleType(dataType)} />
        {arrayBadge ?? ''}
      </span>
      <span className="cfg-var-type-remote">
        <SearchHighlight text={dataType || '—'} />
      </span>
    </span>
  );
}

function WriteValueInput({
  dsName,
  path,
  onClose,
}: {
  dsName: string;
  path: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      sendWsMessage({
        type: 'write_field',
        datasource: dsName,
        path,
        value: trimmed,
      });
    }
    onClose();
  };

  return (
    <input
      ref={inputRef}
      className="cfg-var-write-input"
      value={draft}
      placeholder="Write…"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') send();
        if (e.key === 'Escape') {
          cancelledRef.current = true;
          onClose();
        }
      }}
      onBlur={() => {
        if (!cancelledRef.current) send();
      }}
    />
  );
}

function WritableLiveCell({
  value,
  canWrite,
  dsName,
  path,
}: {
  value: string | undefined;
  canWrite: boolean;
  dsName: string;
  path: string;
}) {
  const [writing, setWriting] = useState(false);

  if (writing && canWrite) {
    return (
      <div className="cfg-vtable-cell cfg-vtable-cell--live">
        <WriteValueInput dsName={dsName} path={path} onClose={() => setWriting(false)} />
      </div>
    );
  }

  return (
    <div
      className={`cfg-vtable-cell cfg-vtable-cell--live${canWrite ? ' cfg-vtable-cell--writable' : ''}`}
      onClick={canWrite ? () => setWriting(true) : undefined}
    >
      <LiveValue value={value} />
    </div>
  );
}

// ── Numeric range (min/max) ─────────────────────────────────────────────────

type RangeBound = 'min' | 'max';

const RANGE_LABELS: Record<RangeBound, string> = {
  min: 'Minimum value',
  max: 'Maximum value',
};

function boundText(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '';
}

function RangeBoundInput({
  bound,
  value,
  counterpart,
  onCommit,
}: {
  bound: RangeBound;
  value: number | undefined;
  /** The other bound as persisted — an inverted pair is refused, not stored. */
  counterpart: number | undefined;
  onCommit: (next: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const revertRef = useRef(false);

  const trimmed = draft?.trim();
  const parsed = trimmed === undefined || trimmed === '' ? undefined : Number(trimmed);
  const notANumber = parsed !== undefined && !Number.isFinite(parsed);
  const inverted =
    parsed !== undefined &&
    counterpart !== undefined &&
    (bound === 'min' ? parsed > counterpart : parsed < counterpart);
  const invalid = notANumber || inverted;

  const commit = () => {
    if (revertRef.current) {
      revertRef.current = false;
      setDraft(null);
      return;
    }
    // An invalid draft stays on screen, flagged: a range the write path cannot
    // enforce (min > max) must not slip into the tree unnoticed, and the
    // backend deliberately leaves such a pair uncorrected once persisted.
    if (draft === null || invalid) return;
    setDraft(null);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <input
      className={`cfg-var-range-input${invalid ? ' cfg-var-range-input--invalid' : ''}`}
      inputMode="decimal"
      value={draft ?? boundText(value)}
      placeholder={bound}
      aria-label={RANGE_LABELS[bound]}
      aria-invalid={invalid || undefined}
      title={
        inverted
          ? 'Minimum must not be above maximum'
          : notANumber
            ? 'Enter a number, or clear the field'
            : RANGE_LABELS[bound]
      }
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          revertRef.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * The Min/Max pair of a variable row. Offered on numeric variables of every
 * datasource type — unlike name/type/access it is HMI-local configuration, not
 * something a browse can supply, so the read-only OPC-UA client rows carry it
 * too (the same reasoning that keeps their `enabled` checkbox live).
 */
function RangeCells({
  entry,
  editable,
  onUpdate,
}: {
  entry: VariableEntry;
  editable: boolean;
  onUpdate: (patch: Pick<VariableEntry, 'min' | 'max'>) => void;
}) {
  if (!editable || !isNumericType(entry.data_type)) {
    return (
      <>
        <div className="cfg-vtable-cell cfg-vtable-cell--range">{boundText(entry.min)}</div>
        <div className="cfg-vtable-cell cfg-vtable-cell--range">{boundText(entry.max)}</div>
      </>
    );
  }
  return (
    <>
      <div className="cfg-vtable-cell cfg-vtable-cell--range">
        <RangeBoundInput
          bound="min"
          value={entry.min}
          counterpart={entry.max}
          onCommit={(next) => onUpdate({ min: next })}
        />
      </div>
      <div className="cfg-vtable-cell cfg-vtable-cell--range">
        <RangeBoundInput
          bound="max"
          value={entry.max}
          counterpart={entry.min}
          onCommit={(next) => onUpdate({ max: next })}
        />
      </div>
    </>
  );
}

interface FolderRowCellsProps {
  folder: FolderEntry;
  depth: number;
  path: string;
  collapsed: Set<string>;
  showLive: boolean;
  isEditable: boolean;
  onToggleFolder: (key: string) => void;
  onSetFolderEnabled: (path: string, nodeId: string | undefined, enabled: boolean) => void;
  onRemoveNode: (path: string) => void;
  onRenameFolder?: (folderPath: string, newName: string) => void;
}

function FolderRowCellsImpl({
  folder,
  depth,
  path,
  collapsed,
  showLive,
  isEditable,
  onToggleFolder,
  onSetFolderEnabled,
  onRemoveNode,
  onRenameFolder,
}: FolderRowCellsProps) {
  const key = path;
  const isCollapsed = collapsed.has(key);
  const { total, enabled } = useMemo(
    () => ({ total: countVars(folder.children), enabled: countEnabledVars(folder.children) }),
    [folder.children],
  );
  const allOn = total > 0 && enabled === total;
  const someOn = enabled > 0 && enabled < total;

  return (
    <>
      <div className="cfg-vtable-cell cfg-vtable-cell--check">
        <input
          type="checkbox"
          className="cfg-check"
          checked={allOn}
          ref={(el) => {
            if (el) el.indeterminate = someOn;
          }}
          onChange={(event) => onSetFolderEnabled(path, folder.node_id, event.target.checked)}
        />
      </div>
      <div className="cfg-vtable-cell cfg-vtable-cell--flush">
        <button
          className="cfg-var-folder-btn"
          style={{ '--row-indent': treePaddingLeft(depth) } as CSSProperties}
          onClick={() => onToggleFolder(key)}
          title={folder.node_id}
        >
          <span className="cfg-var-folder-arrow">{isCollapsed ? '▶' : '▼'}</span>
          {isEditable && onRenameFolder && !/\[\d+\]$/.test(folder.name) ? (
            <InlineTextEdit
              value={folder.name}
              onCommit={(newName) => onRenameFolder(path, newName)}
              title={folder.node_id}
            />
          ) : (
            <SearchHighlight text={folder.name} />
          )}
          <span className="cfg-var-folder-count">
            {enabled}/{total}
          </span>
        </button>
      </div>
      <div className="cfg-vtable-cell">
        {(() => {
          const subFolders = folder.children.filter(isFolder);
          const hasDirectVars = folder.children.some((c) => !isFolder(c));
          const isIndexedArray =
            !hasDirectVars &&
            subFolders.length > 0 &&
            subFolders.every((f) => /\[\d+\]$/.test(f.name));
          if (!isIndexedArray) return null;
          const elemHasVars = subFolders[0]?.children?.some((c) => !isFolder(c));
          const elemHasFolders = subFolders[0]?.children?.some((c) => isFolder(c));
          const isStruct = elemHasVars || elemHasFolders;
          return isStruct ? `struct[${subFolders.length}]` : `array[${subFolders.length}]`;
        })()}
      </div>
      <div className="cfg-vtable-cell" />
      <div className="cfg-vtable-cell cfg-vtable-cell--range" />
      <div className="cfg-vtable-cell cfg-vtable-cell--range" />
      {showLive && <div className="cfg-vtable-cell" />}
      {isEditable && (
        <div className="cfg-vtable-cell cfg-vtable-cell--actions">
          <button
            className="cfg-var-delete-btn"
            onClick={() => onRemoveNode(path)}
            title="Delete folder"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

export const FolderRowCells = memo(FolderRowCellsImpl);

interface VariableRowCellsProps {
  entry: VariableEntry;
  depth: number;
  path: string;
  dsName: string;
  dsType: DatasourceType;
  showLive: boolean;
  isEditable: boolean;
  /** Min/Max editing is offered on every datasource type — see `RangeCells`. */
  rangeEditable: boolean;
  liveValues: Record<string, string>;
  collapsed?: Set<string>;
  onToggleArray?: (key: string) => void;
  onUpdateVar: (path: string, nodeId: string | undefined, patch: Partial<VariableEntry>) => void;
  onRemoveNode: (path: string) => void;
}

export function VariableRowCells({
  entry,
  depth,
  path,
  dsName,
  dsType,
  showLive,
  isEditable,
  rangeEditable,
  liveValues,
  collapsed,
  onToggleArray,
  onUpdateVar,
  onRemoveNode,
}: VariableRowCellsProps) {
  const varKey = buildVarKey(dsName, path);
  const isArray = isArrayShape(entry);
  const isCollapsed = isArray && !!collapsed?.has(path);
  const caps = DATASOURCE_CAPABILITIES[dsType];
  const opcuaTypes = caps.typeEditor === 'opcua';

  return (
    <>
      <div className="cfg-vtable-cell cfg-vtable-cell--check">
        <input
          type="checkbox"
          className="cfg-check"
          checked={entry.enabled}
          onChange={(event) => onUpdateVar(path, entry.node_id, { enabled: event.target.checked })}
        />
      </div>
      <div className="cfg-vtable-cell cfg-vtable-cell--flush">
        {isArray && onToggleArray ? (
          <button
            className="cfg-var-folder-btn"
            style={{ '--row-indent': treePaddingLeft(depth) } as CSSProperties}
            onClick={() => onToggleArray(path)}
            title={entry.node_id}
          >
            <span className="cfg-var-folder-arrow">{isCollapsed ? '▶' : '▼'}</span>
            {isEditable ? (
              <InlineTextEdit
                value={entry.display_name}
                onCommit={(newName) => onUpdateVar(path, entry.node_id, { display_name: newName })}
                title={entry.node_id}
              />
            ) : (
              <SearchHighlight text={entry.display_name} />
            )}
          </button>
        ) : isEditable ? (
          <InlineTextEdit
            value={entry.display_name}
            onCommit={(newName) => onUpdateVar(path, entry.node_id, { display_name: newName })}
            style={
              { '--row-indent': treePaddingLeftWithOffset(depth, '18px + 0.2rem') } as CSSProperties
            }
            title={entry.node_id}
          />
        ) : (
          <div
            className="cfg-var-name-cell"
            style={
              { '--row-indent': treePaddingLeftWithOffset(depth, '18px + 0.2rem') } as CSSProperties
            }
            title={entry.node_id}
          >
            <SearchHighlight text={entry.display_name} />
          </div>
        )}
      </div>
      <div className="cfg-vtable-cell">
        {isEditable ? (
          <div className="cfg-var-type-edit">
            <Select
              className="cfg-select--ghost"
              value={
                opcuaTypes ? canonicalOpcuaType(entry.data_type) : toSimpleType(entry.data_type)
              }
              onChange={(v) =>
                onUpdateVar(path, entry.node_id, {
                  data_type: opcuaTypes ? v : representativeOpcuaType(v),
                })
              }
            >
              {(opcuaTypes ? OPCUA_TYPES : VALUE_TYPES).map((dt) => (
                <option key={dt} value={dt}>
                  {dt}
                </option>
              ))}
            </Select>
          </div>
        ) : caps.dualType ? (
          <DualType dataType={entry.data_type} arrayBadge={arrayBadgeSuffix(entry)} />
        ) : (
          <>
            <SearchHighlight text={toSimpleType(entry.data_type)} />
            {arrayBadgeSuffix(entry)}
          </>
        )}
      </div>
      <div className="cfg-vtable-cell">
        <AccessBadge
          writable={entry.writable}
          showUnknown
          onClick={
            isEditable
              ? () => onUpdateVar(path, entry.node_id, { writable: !entry.writable })
              : undefined
          }
        />
      </div>
      <RangeCells
        entry={entry}
        editable={rangeEditable}
        onUpdate={(patch) => onUpdateVar(path, entry.node_id, patch)}
      />
      {showLive &&
        (isArray ? (
          <div className="cfg-vtable-cell cfg-vtable-cell--live" />
        ) : (
          <WritableLiveCell
            value={liveValues[varKey]}
            canWrite={caps.editable || !!entry.writable}
            dsName={dsName}
            path={path}
          />
        ))}
      {isEditable && (
        <div className="cfg-vtable-cell cfg-vtable-cell--actions">
          <button
            className="cfg-var-delete-btn"
            onClick={() => onRemoveNode(path)}
            title="Delete variable"
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

interface ArrayElementRowCellsProps {
  parent: VariableEntry;
  index: number;
  depth: number;
  path: string;
  dsName: string;
  dsType: DatasourceType;
  showLive: boolean;
  isEditable: boolean;
}

export function ArrayElementRowCells({
  parent,
  index,
  depth,
  path,
  dsName,
  dsType,
  showLive,
  isEditable,
}: ArrayElementRowCellsProps) {
  const varKey = buildVarKey(dsName, path);
  const elementValue = useVariableStore((s) => {
    const arr = s.values[varKey];
    return Array.isArray(arr) ? arr[index] : undefined;
  });
  const displayStr = elementValue !== undefined ? String(elementValue) : undefined;
  const caps = DATASOURCE_CAPABILITIES[dsType];
  const canWrite = caps.editable || !!parent.writable;
  const writePath = `${path}[${index}]`;

  return (
    <>
      <div className="cfg-vtable-cell cfg-vtable-cell--check" />
      <div
        className="cfg-vtable-cell cfg-vtable-cell--array-element-name"
        style={
          { '--row-indent': treePaddingLeftWithOffset(depth, '18px + 0.2rem') } as CSSProperties
        }
      >
        [{index}]
      </div>
      <div className="cfg-vtable-cell">
        {caps.dualType ? (
          <DualType dataType={parent.data_type} />
        ) : (
          <SearchHighlight text={toSimpleType(parent.data_type)} />
        )}
      </div>
      <div className="cfg-vtable-cell">
        <AccessBadge writable={parent.writable} showUnknown />
      </div>
      <div className="cfg-vtable-cell cfg-vtable-cell--range" />
      <div className="cfg-vtable-cell cfg-vtable-cell--range" />
      {showLive && (
        <WritableLiveCell value={displayStr} canWrite={canWrite} dsName={dsName} path={writePath} />
      )}
      {isEditable && <div className="cfg-vtable-cell cfg-vtable-cell--actions" />}
    </>
  );
}
