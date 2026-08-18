/**
 * DatasourceTree — left sidebar for the VariablesView.
 *
 * Fixed "Datasources" root node with + button (add) and right-click context
 * menu (Add ▶ submenu). Child items right-click to Remove.
 *
 * Uses shared cfg-tree* classes (config.css) matching the Editor's WidgetTree
 * and the Translation's DictionaryTree.
 */

import { useState } from 'react';
import type {
  DatasourceListItem,
  DatasourceSettings,
  DatasourceType,
} from '@shared/types/datasource';
import { useVariablesDomainStore } from '@config/store/domains/variablesDomainStore';
import {
  ContextMenu,
  ContextMenuItem,
  ContextSubmenu,
  ContextItemIcon,
} from '../../ui/ContextMenu';
import { TreeRowActionButton } from '../../ui/TreeAffordances';
import TreeRow from '../../ui/TreeRow';
import NameInputModal from '../../ui/NameInputModal';
import OpcuaConnectionWizard from '../OpcuaConnectionWizard';
import { useContextMenu } from '@config/hooks/useContextMenu';
import { useDeleteConfirm } from '@config/hooks/useDeleteConfirm';

interface Props {
  datasources: DatasourceListItem[];
  selectedName: string | null;
  existingNames: string[];
  onSelect: (name: string) => void;
  onAdd: (type: DatasourceType, name: string, settings?: Partial<DatasourceSettings>) => void;
  onDelete: (name: string) => void;
  onBrowseVariables: (name: string) => void;
}

const TYPE_ICONS: Record<DatasourceType, string> = {
  'opcua-client': '◉',
  static: '≡',
  'opcua-test-server': '○',
};

const TYPE_LABELS: Record<DatasourceType, string> = {
  'opcua-client': 'OPC-UA Client',
  static: 'Static Variables',
  'opcua-test-server': 'OPC-UA Test Server',
};

const DS_TYPES = ['opcua-client', 'static'] as const satisfies readonly DatasourceType[];

function DatasourceTypeItems({
  onClose,
  onPickType,
}: {
  onClose: () => void;
  onPickType: (type: DatasourceType) => void;
}) {
  return DS_TYPES.map((type) => (
    <ContextMenuItem
      key={type}
      onClick={() => {
        onPickType(type);
        onClose();
      }}
    >
      <ContextItemIcon>{TYPE_ICONS[type]}</ContextItemIcon>
      {TYPE_LABELS[type]}
    </ContextMenuItem>
  ));
}

// ── Type picker menu — shown from + button, lists types directly ──────────────
function DsTypeMenu({
  x,
  y,
  onClose,
  onPickType,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onPickType: (t: DatasourceType) => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <DatasourceTypeItems onClose={onClose} onPickType={onPickType} />
    </ContextMenu>
  );
}

// ── Root context menu — right-click, shows "Add" with expandable submenu ──────
function DsRootCtxMenu({
  x,
  y,
  onClose,
  onPickType,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onPickType: (t: DatasourceType) => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <ContextSubmenu label="Add">
        <DatasourceTypeItems onClose={onClose} onPickType={onPickType} />
      </ContextSubmenu>
    </ContextMenu>
  );
}

// ── Child context menu — right-click on a datasource, shows Remove ────────────
function DsChildCtxMenu({
  x,
  y,
  name,
  onClose,
  onRemove,
}: {
  x: number;
  y: number;
  name: string;
  onClose: () => void;
  onRemove: (n: string) => void;
}) {
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <ContextMenuItem
        danger
        onClick={() => {
          onRemove(name);
          onClose();
        }}
      >
        Remove
      </ContextMenuItem>
    </ContextMenu>
  );
}

// ── DatasourceTree root ───────────────────────────────────────────────────────
export default function DatasourceTree({
  datasources,
  selectedName,
  existingNames,
  onSelect,
  onAdd,
  onDelete,
  onBrowseVariables,
}: Props) {
  const rootExpanded = useVariablesDomainStore((s) => s.datasourceTreeExpanded);
  const setRootExpanded = useVariablesDomainStore((s) => s.setDatasourceTreeExpanded);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const rootMenu = useContextMenu();
  const childMenu = useContextMenu<{ name: string }>();
  const [addType, setAddType] = useState<DatasourceType | null>(null);
  const deleteConfirm = useDeleteConfirm<string>({
    message: (name) => `Delete "${name}"? This cannot be undone.`,
    onConfirm: onDelete,
  });

  function handleRootContextMenu(e: React.MouseEvent) {
    setAddMenu(null);
    rootMenu.open(e, {});
  }

  function handleAddBtnClick(e: React.MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rootMenu.close();
    setAddMenu({ x: rect.left, y: rect.bottom + 2 });
  }

  function pickType(type: DatasourceType) {
    setAddMenu(null);
    rootMenu.close();
    setAddType(type);
  }

  return (
    <div className="cfg-tree cfg-ds-tree">
      <div className="cfg-tree__scroll">
        {/* ── Fixed root node ── */}
        <TreeRow
          variant="group"
          toggle={{ open: rootExpanded, onClick: () => setRootExpanded(!rootExpanded) }}
          icon={
            /* Database outline icon */
            <svg
              className="cfg-tree-item__icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
              aria-hidden
            >
              <ellipse cx="8" cy="4.5" rx="6" ry="2" />
              <path d="M2 4.5v3c0 1.105 2.686 2 6 2s6-.895 6-2v-3" />
              <path d="M2 7.5v3c0 1.105 2.686 2 6 2s6-.895 6-2v-3" />
            </svg>
          }
          label={<span className="cfg-tree-item__label">Datasources</span>}
          onSelect={() => setRootExpanded(!rootExpanded)}
          onContextMenu={handleRootContextMenu}
        >
          <span className="cfg-tree-item__count">{datasources.length}</span>
          <TreeRowActionButton title="Add datasource" onClick={handleAddBtnClick}>
            +
          </TreeRowActionButton>
        </TreeRow>

        {/* ── Datasource children ── */}
        {rootExpanded &&
          datasources.map((ds) => (
            <TreeRow
              key={ds.name}
              depth={1}
              selected={selectedName === ds.name}
              icon={<span className="cfg-tree-item__icon">{TYPE_ICONS[ds.type]}</span>}
              label={<span className="cfg-tree-item__label">{ds.name}</span>}
              onSelect={() => onSelect(ds.name)}
              onContextMenu={(e) => childMenu.open(e, { name: ds.name })}
            >
              <span
                title={ds.error ?? undefined}
                className={`cfg-status-dot cfg-ds-status-dot${
                  ds.connected
                    ? ' cfg-status-dot--connected'
                    : ds.error
                      ? ' cfg-status-dot--error'
                      : ds.type === 'static'
                        ? ' cfg-status-dot--static cfg-ds-status-dot--static'
                        : ''
                }`}
              />
            </TreeRow>
          ))}

        {/* ── Empty state ── */}
        {rootExpanded && datasources.length === 0 && (
          <div className="cfg-tree-section-empty">
            Click + or right-click "Datasources" to add one.
          </div>
        )}
      </div>

      {/* ── Type picker menu (from + button) ── */}
      {addMenu && (
        <DsTypeMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          onPickType={pickType}
        />
      )}

      {/* ── Root context menu (right-click) ── */}
      {rootMenu.state && (
        <DsRootCtxMenu
          x={rootMenu.state.x}
          y={rootMenu.state.y}
          onClose={rootMenu.close}
          onPickType={pickType}
        />
      )}

      {/* ── Child context menu (right-click on datasource) ── */}
      {childMenu.state && (
        <DsChildCtxMenu
          x={childMenu.state.x}
          y={childMenu.state.y}
          name={childMenu.state.name}
          onClose={childMenu.close}
          onRemove={(n) => {
            childMenu.close();
            deleteConfirm.ask(n);
          }}
        />
      )}

      {/* ── Add OPC-UA client via connection wizard ── */}
      {addType === 'opcua-client' && (
        <OpcuaConnectionWizard
          existingNames={existingNames}
          onCreate={(name, settings) => onAdd('opcua-client', name, settings)}
          onCreateEmpty={(name) => onAdd('opcua-client', name)}
          onBrowseVariables={onBrowseVariables}
          onClose={() => setAddType(null)}
        />
      )}

      {/* ── Add other datasource types (name-only) ── */}
      {addType && addType !== 'opcua-client' && (
        <NameInputModal
          title={`New ${TYPE_LABELS[addType]}`}
          placeholder="Datasource name…"
          onConfirm={(name) => {
            onAdd(addType, name);
            setAddType(null);
          }}
          onCancel={() => setAddType(null)}
        />
      )}

      {deleteConfirm.modal}
    </div>
  );
}
