import { useMemo, useState } from 'react';
import type { ActionsConfig, MenuItemConfig } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import { useConfigStore } from '@shared/store/configStore';
import { flattenPages, resolvePageTitle } from '@shared/utils/pageTree';
import Select from '@config/components/ui/Select';
import PropRow from '@config/components/ui/PropRow';
import FieldGroup from '@config/components/ui/FieldGroup';
import { ClearIcon } from '@config/components/ui/actionIcons';
import { renderSchemaField } from '@config/utils/renderSchemaField';
import { KindLabel, Kw, PreviewText } from '../PropertySourceEditor/editors/shared';
import ActionsInput from './ActionsInput';

/** Field schemas for the per-variant rows. Module constants so every row shares
 *  one object — each exists only to pick `renderSchemaField`'s control. */
const LABEL_SCHEMA: SchemaField = { type: 'String', label: 'Label' };
const HEADING_SCHEMA: SchemaField = { type: 'String', label: 'Heading' };
const ICON_SCHEMA: SchemaField = { type: 'icon', label: 'Icon' };
const PAGE_SCHEMA: SchemaField = { type: 'String', format: 'page', label: 'Page' };
const URL_SCHEMA: SchemaField = { type: 'String', format: 'url', label: 'URL' };
const TARGET_SCHEMA: SchemaField = {
  type: 'String',
  format: 'select',
  label: 'Target',
  defaultValue: '_self',
  options: [
    { label: 'Same tab', value: '_self' },
    { label: 'New tab', value: '_blank' },
  ],
};

type MenuItemType = MenuItemConfig['type'];

const ITEM_TYPES: { type: MenuItemType; label: string }[] = [
  { type: 'page-link', label: 'Page Link' },
  { type: 'external-link', label: 'External Link' },
  { type: 'action', label: 'Action' },
  { type: 'submenu', label: 'Submenu' },
  { type: 'section-header', label: 'Section Header' },
  { type: 'divider', label: 'Divider' },
];

/** Tint token per variant, so a scanned list separates by colour as well as by
 *  word — the rule `ACTION_TYPE_TINT` follows for the action list. */
const ITEM_TYPE_TINT: Record<MenuItemType, string> = {
  'page-link': 'page',
  'external-link': 'urlParam',
  action: 'result',
  submenu: 'if',
  'section-header': 'time',
  divider: 'static',
};

const EMPTY_ITEMS: MenuItemConfig[] = [];

/** A new item of the picked type, with every required field present but empty —
 *  the contract `makeDefaultAction` keeps for actions. */
function makeDefaultItem(type: MenuItemType): MenuItemConfig {
  switch (type) {
    case 'page-link':
      return { type, pageId: '' };
    case 'external-link':
      return { type, url: '', label: '' };
    case 'action':
      return { type, actions: [], label: '' };
    case 'submenu':
      return { type, label: '', items: [] };
    case 'section-header':
      return { type, label: '' };
    case 'divider':
      return { type };
  }
}

/** Whatever identifies an item beyond its variant — its label, else the page or
 *  URL it points at. Null when the variant name already says everything. */
function menuItemPreview(item: MenuItemConfig, pageTitles: Record<string, string>): string | null {
  switch (item.type) {
    case 'page-link':
      return item.label || pageTitles[item.pageId] || item.pageId || null;
    case 'external-link':
      return item.label || item.url || null;
    case 'submenu':
      return item.label || `${item.items.length} item${item.items.length === 1 ? '' : 's'}`;
    case 'action':
    case 'section-header':
      return item.label || null;
    case 'divider':
      return null;
  }
}

interface Props {
  value: MenuItemConfig[] | undefined;
  onChange: (v: MenuItemConfig[]) => void;
  /** Section title shown beside the add control. */
  title: string;
  description?: string;
  /** Selection-path prefix to this list — `['items']` at the top level,
   *  `['items', '0', 'items']` for a submenu's own list. */
  pathPrefix?: string[];
}

/**
 * Editor for a NavigationMenu's manual item list.
 *
 * Same shell as the `$switch` case list and the action list: the add control
 * sits behind the title and each entry is one collapsible row carrying its own
 * editors, so an item is edited where it sits rather than in a detached pane.
 * Recursive — a `submenu` item hosts this same list for its children.
 *
 * The add control is a type menu rather than a bare `+ Add`: the six variants
 * share no common field, so an item added without one would have no editors to
 * show and no valid shape to persist.
 */
export default function MenuItemsInput({ value, onChange, title, description, pathPrefix }: Props) {
  const items = value ?? EMPTY_ITEMS;
  const pages = useConfigStore((s) => s.pages);
  const pageTitles = useMemo(
    () => Object.fromEntries(flattenPages(pages).map((p) => [p.id, resolvePageTitle(p.title)])),
    [pages],
  );

  // One item open at a time — the row itself hosts the editors, so expanding a
  // second would push the first far off screen inside a narrow panel.
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function addItem(type: MenuItemType) {
    onChange([...items, makeDefaultItem(type)]);
    setExpandedIdx(items.length);
  }

  function removeItem(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
    setExpandedIdx(null);
  }

  function patchItem(idx: number, patch: Record<string, unknown>) {
    onChange(items.map((it, i) => (i === idx ? ({ ...it, ...patch } as MenuItemConfig) : it)));
  }

  return (
    <div className="cfg-editor-actions cfg-menu-items">
      <div className="cfg-editor-actions__title-row">
        <span className="cfg-field-group__label">{title}</span>
        <Select
          className="cfg-editor-actions__add"
          popupClassName="cfg-menu-items__add-popup"
          value=""
          onChange={(v) => {
            if (v) addItem(v as MenuItemType);
          }}
        >
          <option value="">Add</option>
          {ITEM_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      {description && <p className="cfg-field-group__desc">{description}</p>}

      {items.length === 0 ? (
        <div className="cfg-menu-items__empty">No items yet</div>
      ) : (
        items.map((item, idx) => (
          <MenuItemRow
            key={idx}
            item={item}
            path={[...(pathPrefix ?? []), String(idx)]}
            pageTitles={pageTitles}
            expanded={expandedIdx === idx}
            onExpandedChange={(next) => setExpandedIdx(next ? idx : null)}
            onPatch={(patch) => patchItem(idx, patch)}
            onRemove={() => removeItem(idx)}
          />
        ))
      )}
    </div>
  );
}

function MenuItemRow({
  item,
  path,
  pageTitles,
  expanded,
  onExpandedChange,
  onPatch,
  onRemove,
}: {
  item: MenuItemConfig;
  path: string[];
  pageTitles: Record<string, string>;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const kind = ITEM_TYPES.find((t) => t.type === item.type)?.label ?? item.type;
  const tint = ITEM_TYPE_TINT[item.type];
  // The variant leads the collapsed summary in its own tint, the way an action
  // row's summary leads with its verb: a row previewing only a label reads the
  // same whether it is a section header, an external link or a submenu. It
  // carries the same tint in `kindLabel`, which is what the content slot shows
  // once expanded — an open row in a long mixed list must still say what it is.
  const identity = menuItemPreview(item, pageTitles);

  return (
    <FieldGroup
      tier={3}
      kindLabel={
        <KindLabel>
          <Kw tint={tint}>{kind}</Kw>
        </KindLabel>
      }
      summary={
        <PreviewText>
          <Kw tint={tint}>{kind}</Kw>
          {identity != null && <> “{identity}”</>}
        </PreviewText>
      }
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      actions={
        <button
          type="button"
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          title="Remove item"
          onClick={onRemove}
        >
          <ClearIcon />
        </button>
      }
    >
      <MenuItemFields item={item} path={path} onPatch={onPatch} />
    </FieldGroup>
  );
}

/** One field inside an item — the shape `ActionFieldRow` gives an action's
 *  fields, so each carries its own copy/paste selection path. */
function ItemField({
  path,
  fieldKey,
  schema,
  value,
  onChange,
}: {
  path: string[];
  fieldKey: string;
  schema: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <PropRow label={schema.label} selection={{ path: [...path, fieldKey], schema }}>
      {renderSchemaField(schema, value, onChange)}
    </PropRow>
  );
}

function MenuItemFields({
  item,
  path,
  onPatch,
}: {
  item: MenuItemConfig;
  path: string[];
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const iconField = (
    <ItemField
      path={path}
      fieldKey="icon"
      schema={ICON_SCHEMA}
      value={'icon' in item ? item.icon : undefined}
      onChange={(v) => onPatch({ icon: v })}
    />
  );
  const labelField = (schema: SchemaField) => (
    <ItemField
      path={path}
      fieldKey="label"
      schema={schema}
      value={'label' in item ? item.label : undefined}
      onChange={(v) => onPatch({ label: v ?? '' })}
    />
  );

  switch (item.type) {
    case 'page-link':
      return (
        <>
          <ItemField
            path={path}
            fieldKey="pageId"
            schema={PAGE_SCHEMA}
            value={item.pageId}
            onChange={(v) => onPatch({ pageId: v ?? '' })}
          />
          {labelField(LABEL_SCHEMA)}
          {iconField}
        </>
      );
    case 'external-link':
      return (
        <>
          <ItemField
            path={path}
            fieldKey="url"
            schema={URL_SCHEMA}
            value={item.url}
            onChange={(v) => onPatch({ url: v ?? '' })}
          />
          {labelField(LABEL_SCHEMA)}
          <ItemField
            path={path}
            fieldKey="target"
            schema={TARGET_SCHEMA}
            value={item.target}
            onChange={(v) => onPatch({ target: v })}
          />
          {iconField}
        </>
      );
    case 'action':
      return (
        <>
          {labelField(LABEL_SCHEMA)}
          {iconField}
          {/* `eventKey` is the real field name, so a nested action's selection
              path reads `items/0/actions/0` — the JSON path, not a synthetic
              event key the item shape does not have. */}
          <ActionsInput
            value={{ actions: item.actions } as ActionsConfig}
            onChange={(v) => onPatch({ actions: (v as ActionsConfig).actions ?? [] })}
            eventKey="actions"
            headerTitle="Actions"
            pathPrefix={path}
          />
        </>
      );
    case 'submenu':
      return (
        <>
          {labelField(LABEL_SCHEMA)}
          {iconField}
          <MenuItemsInput
            value={item.items}
            onChange={(v) => onPatch({ items: v })}
            title="Items"
            pathPrefix={[...path, 'items']}
          />
        </>
      );
    case 'section-header':
      return labelField(HEADING_SCHEMA);
    case 'divider':
      return <p className="cfg-prop-hint">A separator line — nothing to configure.</p>;
  }
}
