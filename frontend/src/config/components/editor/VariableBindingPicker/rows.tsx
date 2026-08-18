/**
 * Row renderers for the VariableBindingPicker virtual list.
 *
 * Each row kind (datasource header, folder, array element, component
 * prop, component-prop node) is its own small component that takes the strongly-typed
 * `RowItem` variant plus a shared `RowContext` of selection/collapse helpers.
 *
 * Extracted from index.tsx to keep the picker shell focused on data flow.
 */

import type { CSSProperties } from 'react';
import AccessBadge from '@config/components/ui/AccessBadge';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import type { PickerVariableEntry } from '@config/components/ui/datasourceTreeHelpers';
import { isStructType, primaryType } from '@shared/utils/valueTypes';
import { arrayBadgeSuffix, isArrayShape } from '@shared/types/arrayShape';
import { ToggleSlot, EmptyToggleSlot, GroupHeaderRow } from '../BindingPickerShell/rowParts';
import { formatTypeBadge } from './helpers';
import { folderKey, arrayExpansionKey, type RowItem } from './variableTreeHelpers';

export interface RowContext {
  rowStyle: CSSProperties;
  selectedKey: string | null;
  collapsed: Set<string>;
  toggleCollapsed: (key: string) => void;
  selectKey: (key: string) => void;
  /** Component-prop confirm — pick the key and close the picker. */
  onPickAndClose: (key: string) => void;
  /** Datasource names whose children are currently being fetched. */
  dsLoading: Set<string>;
}

type Extract<T, K> = T extends { kind: K } ? T : never;

function ComponentPropRow({
  item,
  ctx,
}: {
  item: Extract<RowItem, 'component-prop'>;
  ctx: RowContext;
}) {
  const { key, propKey, schema } = item;
  const { rowStyle, selectedKey, collapsed, toggleCollapsed, selectKey, onPickAndClose } = ctx;
  const isSelected = key === selectedKey;
  const isStructWithChildren =
    isStructType(primaryType(schema.type)) && !!schema.structSchema?.length;
  const isExpanded = isStructWithChildren && !collapsed.has(key);
  return (
    <div
      className={`editor-binding-item editor-binding-item--selectable editor-binding-item--component-prop${isSelected ? ' editor-binding-item--selected' : ''}`}
      style={rowStyle}
      onClick={() => selectKey(key)}
      onDoubleClick={() => onPickAndClose(key)}
    >
      {isStructWithChildren ? (
        <ToggleSlot
          open={isExpanded}
          onToggle={(e) => {
            e.stopPropagation();
            toggleCollapsed(key);
          }}
        />
      ) : (
        <EmptyToggleSlot />
      )}
      <span className="cfg-text-truncate editor-binding-item__name">
        <SearchHighlight text={schema.label} />
      </span>
      <span className="cfg-text-truncate editor-binding-item__propkey">
        <SearchHighlight text={propKey} />
      </span>
      <span className="editor-binding-char-row__type cfg-text-truncate">
        <SearchHighlight text={formatTypeBadge(schema.type)} />
      </span>
      {schema.write !== undefined && <AccessBadge writable={schema.write} />}
    </div>
  );
}

function ComponentPropNodeRow({
  item,
  ctx,
}: {
  item: Extract<RowItem, 'component-prop-node'>;
  ctx: RowContext;
}) {
  const { itemKey, node } = item;
  const { rowStyle, selectedKey, collapsed, toggleCollapsed, selectKey, onPickAndClose } = ctx;
  const isLeaf = node.kind === 'variable';
  const isFolderNode = node.kind === 'folder' || node.kind === 'array';
  const isSelectable = isLeaf || isFolderNode;
  const hasChildren = isFolderNode && !!node.children?.length;
  const isExpanded = hasChildren && !collapsed.has(itemKey);
  const isSelected = itemKey === selectedKey;
  return (
    <div
      className={`editor-binding-item${isSelectable ? ' editor-binding-item--selectable' : ''}${isSelected ? ' editor-binding-item--selected' : ''}`}
      style={rowStyle}
      onClick={isSelectable ? () => selectKey(itemKey) : undefined}
      onDoubleClick={isSelectable ? () => onPickAndClose(itemKey) : undefined}
    >
      {hasChildren ? (
        <ToggleSlot
          open={isExpanded}
          onToggle={(e) => {
            e.stopPropagation();
            toggleCollapsed(itemKey);
          }}
        />
      ) : (
        <EmptyToggleSlot />
      )}
      <span className="cfg-text-truncate editor-binding-item__name">
        <SearchHighlight text={node.name} />
      </span>
      {isLeaf && (
        <span className="editor-binding-char-row__type cfg-text-truncate">
          <SearchHighlight text={node.type ?? '—'} />
        </span>
      )}
      {isLeaf && <AccessBadge writable={node.write === true} />}
    </div>
  );
}

function ComponentPropSourceRow({
  item,
  ctx,
}: {
  item: Extract<RowItem, 'component-prop-source'>;
  ctx: RowContext;
}) {
  const { rowStyle, collapsed, toggleCollapsed } = ctx;
  return (
    <GroupHeaderRow
      rowStyle={rowStyle}
      isOpen={!collapsed.has(item.key)}
      name={item.name}
      meta={item.meta}
      onToggle={() => toggleCollapsed(item.key)}
    />
  );
}

function DatasourceRow({ item, ctx }: { item: Extract<RowItem, 'datasource'>; ctx: RowContext }) {
  const { rowStyle, collapsed, toggleCollapsed, dsLoading } = ctx;
  const key = `ds:${item.node.name}`;
  return (
    <GroupHeaderRow
      rowStyle={rowStyle}
      isOpen={!collapsed.has(key)}
      isLoading={dsLoading.has(item.node.name)}
      name={<SearchHighlight text={item.node.name} />}
      meta={<SearchHighlight text={item.node.type} />}
      onToggle={() => toggleCollapsed(key)}
    />
  );
}

function FolderRow({ item, ctx }: { item: Extract<RowItem, 'folder'>; ctx: RowContext }) {
  const { rowStyle, selectedKey, collapsed, toggleCollapsed, selectKey } = ctx;
  const key = folderKey(item.folder);
  const isOpen = !collapsed.has(key);
  const hasChildren = item.folder.children.length > 0;
  const compositeKey = `${item.folder._datasource ?? ''}:${item.folder._path ?? item.folder.name}`;
  const isSelected = item.folder.selectable ? compositeKey === selectedKey : false;
  return (
    <div
      className={`editor-binding-item${item.folder.selectable ? ' editor-binding-item--selectable' : ''}${isSelected ? ' editor-binding-item--selected' : ''}`}
      style={rowStyle}
      onClick={() => (item.folder.selectable ? selectKey(compositeKey) : toggleCollapsed(key))}
    >
      {hasChildren ? (
        <ToggleSlot
          open={isOpen}
          onToggle={(e) => {
            e.stopPropagation();
            toggleCollapsed(key);
          }}
        />
      ) : (
        <EmptyToggleSlot />
      )}
      <span className="cfg-text-truncate editor-binding-item__name">
        {item.folder.selectable ? '⊞ ' : ''}
        <SearchHighlight text={item.folder.name} />
      </span>
    </div>
  );
}

function ArrayElementRow({
  item,
  ctx,
}: {
  item: Extract<RowItem, 'array-element'>;
  ctx: RowContext;
}) {
  const { rowStyle, selectedKey, selectKey } = ctx;
  const parent = item.parent as PickerVariableEntry;
  const elemKey = `${parent._datasource ?? ''}:${parent._path ?? parent.display_name}[${item.index}]`;
  const isSelected = elemKey === selectedKey;
  return (
    <div
      className={`editor-binding-item editor-binding-item--array-element${isSelected ? ' editor-binding-item--selected' : ''}`}
      style={rowStyle}
      onClick={() => selectKey(elemKey)}
    >
      <EmptyToggleSlot />
      <span className="cfg-text-truncate editor-binding-item__name">[{item.index}]</span>
      {parent.data_type && (
        <span className="editor-binding-char-row__type cfg-text-truncate">
          <SearchHighlight text={parent.data_type} />
        </span>
      )}
      <AccessBadge writable={parent.writable} />
    </div>
  );
}

function VariableRow({ item, ctx }: { item: Extract<RowItem, 'variable'>; ctx: RowContext }) {
  const { rowStyle, selectedKey, collapsed, toggleCollapsed, selectKey } = ctx;
  const v = item.entry;
  const compositeKey = v._datasource && v._path ? `${v._datasource}:${v._path}` : v.display_name;
  const isSelected = compositeKey === selectedKey;
  const isArrayVar = isArrayShape(v);
  const arrKey = isArrayVar ? arrayExpansionKey(v) : '';
  const isArrOpen = isArrayVar && !collapsed.has(arrKey);
  return (
    <div
      className={`editor-binding-item${isSelected ? ' editor-binding-item--selected' : ''}`}
      style={rowStyle}
      onClick={() => selectKey(compositeKey)}
      title={v.node_id}
    >
      {isArrayVar ? (
        <ToggleSlot
          open={isArrOpen}
          onToggle={(e) => {
            e.stopPropagation();
            toggleCollapsed(arrKey);
          }}
        />
      ) : (
        <EmptyToggleSlot />
      )}
      <span className="cfg-text-truncate editor-binding-item__name">
        <SearchHighlight text={v.display_name} />
      </span>
      {v.data_type && (
        <span className="editor-binding-char-row__type cfg-text-truncate">
          <SearchHighlight text={v.data_type} />
          {arrayBadgeSuffix(v)}
        </span>
      )}
      <AccessBadge writable={v.writable} />
    </div>
  );
}

export function PickerRow({ item, ctx }: { item: RowItem; ctx: RowContext }) {
  switch (item.kind) {
    case 'component-prop':
      return <ComponentPropRow item={item} ctx={ctx} />;
    case 'component-prop-node':
      return <ComponentPropNodeRow item={item} ctx={ctx} />;
    case 'component-prop-source':
      return <ComponentPropSourceRow item={item} ctx={ctx} />;
    case 'datasource':
      return <DatasourceRow item={item} ctx={ctx} />;
    case 'folder':
      return <FolderRow item={item} ctx={ctx} />;
    case 'array-element':
      return <ArrayElementRow item={item} ctx={ctx} />;
    case 'variable':
      return <VariableRow item={item} ctx={ctx} />;
  }
}
