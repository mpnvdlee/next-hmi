/**
 * RightPanel — the right-hand "Required" + "Selected" preview pane shown by
 * VariableBindingPicker. Three modes: component-prop, var-mode struct, var-mode
 * scalar.
 */

import type { ReactNode } from 'react';
import AccessBadge from '@config/components/ui/AccessBadge';
import type {
  PickerFolderEntry,
  PickerVariableEntry,
  PickerTreeNode,
} from '@config/components/ui/datasourceTreeHelpers';
import { isFolder } from '@shared/types/datasource';
import { accepts, nodeVarType, parseTypeToken } from '@shared/types/varType';
import { acceptedValueTypes } from '@shared/utils/valueTypes';
import { arrayBadgeSuffix } from '@shared/types/arrayShape';
import type { StructSchemaNode, ComponentPropertySchema } from '@shared/types/componentProperty';
import {
  rfName,
  rfType,
  rfNeedsWrite,
  rfNestedFields,
  type RequiredFieldEntry,
} from '../bindingPickerUtils';
import { formatTypeBadge, hasRequiredFields } from './helpers';
import RequiredFieldsTree from './RequiredFieldsTree';

type FolderEntry = PickerFolderEntry;
type VariableEntry = PickerVariableEntry;
type TreeNode = PickerTreeNode;

// ── Local helpers ────────────────────────────────────────────────────────────

/** For an array-of-struct folder, return the children of element [0] so that
 *  the requirement display shows fields rather than the element sub-folders. */
function firstElementChildren(folder: FolderEntry): TreeNode[] {
  const first = folder.children.find((c): c is FolderEntry => isFolder(c) && /\[0\]$/.test(c.name));
  return first ? first.children : folder.children;
}

function splitPath(path: string): { parentPath: string; varName: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { parentPath: '', varName: path }
    : { parentPath: path.slice(0, slash), varName: path.slice(slash + 1) };
}

function FolderPathBadge({ ds, parentPath }: { ds?: string; parentPath: string }) {
  if (!ds) return null;
  return (
    <span className="editor-binding-char-row__type editor-binding-folder-path">
      {parentPath ? `${ds}:${parentPath}` : ds}
    </span>
  );
}

// ── Reused selected-row blocks ───────────────────────────────────────────────

/** Header for a selected scalar/array-element variable. */
function SelectedVarRow({ entry, elementIndex }: { entry: VariableEntry; elementIndex?: number }) {
  if (!entry._datasource || !entry._path) return null;
  const { parentPath, varName } = splitPath(entry._path);
  const displayName = elementIndex !== undefined ? `${varName}[${elementIndex}]` : varName;
  const typeText =
    elementIndex !== undefined
      ? (entry.data_type ?? '—')
      : `${entry.data_type ?? '—'}${arrayBadgeSuffix(entry)}`;
  return (
    <>
      <FolderPathBadge ds={entry._datasource} parentPath={parentPath} />
      <div className="editor-binding-req-row editor-binding-req-row--parent">
        <span className="editor-binding-req-row__name">{displayName}</span>
        <span className="editor-binding-char-row__type">{typeText}</span>
        <AccessBadge writable={entry.writable} />
      </div>
    </>
  );
}

/** Header + children preview for a selected folder (struct / array-of-struct). */
function SelectedFolderRow({
  folder,
  requiredFields,
}: {
  folder: FolderEntry;
  requiredFields?: RequiredFieldEntry[];
}) {
  const ds = folder._datasource;
  const path = folder._path ?? folder.name;
  const { parentPath } = splitPath(path);
  return (
    <>
      <FolderPathBadge ds={ds} parentPath={parentPath} />
      <div className="editor-binding-req-row editor-binding-req-row--parent">
        <span className="editor-binding-req-row__name">{folder.name}</span>
      </div>
      <div className="editor-binding-children-group">
        <FolderChildrenTree nodes={firstElementChildren(folder)} requiredFields={requiredFields} />
      </div>
    </>
  );
}

// ── Trees rendered inside the panel ──────────────────────────────────────────

function FolderChildrenTree({
  nodes,
  requiredFields,
}: {
  nodes: TreeNode[];
  requiredFields?: RequiredFieldEntry[];
}) {
  const reqMap = requiredFields ? new Map(requiredFields.map((f) => [rfName(f), rfType(f)])) : null;
  const nestedReqMap = requiredFields
    ? new Map(
        requiredFields
          .filter((f) => rfNestedFields(f)?.length)
          .map((f) => [rfName(f), rfNestedFields(f)!]),
      )
    : null;
  return (
    <>
      {nodes.map((n, i) => {
        if (isFolder(n)) {
          const nestedReqs = nestedReqMap?.get(n.name);
          const folderNameMatches = reqMap ? reqMap.has(n.name) : false;
          const folderIsMatched =
            folderNameMatches && (nestedReqs ? hasRequiredFields(n, nestedReqs) : true);
          const folderIsUnused = !!reqMap && !folderNameMatches;
          return (
            <div key={n.node_id ?? `f${i}`}>
              <div
                className={`editor-binding-char-row editor-binding-char-row--folder${folderIsMatched ? ' editor-binding-char-row--matched' : ''}${folderIsUnused ? ' editor-binding-char-row--unused' : ''}`}
              >
                <span className="editor-binding-char-row__name">{n.name}</span>
              </div>
              {n.children.length > 0 && (
                <div className="editor-binding-tree-children">
                  <FolderChildrenTree nodes={n.children} requiredFields={nestedReqs} />
                </div>
              )}
            </div>
          );
        }
        const nameMatches = reqMap ? reqMap.has(n.display_name) : false;
        const isUnused = !!reqMap && !nameMatches;
        return (
          <div
            key={n._path ?? n.display_name}
            className={`editor-binding-char-row${isUnused ? ' editor-binding-char-row--unused' : ''}`}
          >
            <span className="editor-binding-char-row__name">{n.display_name}</span>
            <span className="editor-binding-char-row__type">
              {n.data_type}
              {arrayBadgeSuffix(n)}
            </span>
            <AccessBadge writable={n.writable} />
          </div>
        );
      })}
    </>
  );
}

function RequiredFieldTree({
  fields,
  childMap,
  childFolders,
}: {
  fields: RequiredFieldEntry[];
  childMap?: Record<string, VariableEntry>;
  childFolders?: Record<string, FolderEntry>;
}) {
  return (
    <>
      {fields.map((f, i) => {
        const name = rfName(f);
        const needsWrite = rfNeedsWrite(f);
        const expectedType = rfType(f);
        const nested = rfNestedFields(f);
        if (nested?.length) {
          const subFolder = childFolders?.[name];
          const folderMatched = subFolder !== undefined && hasRequiredFields(subFolder, nested);
          const showFolderSlot = childFolders !== undefined;
          const nestedChildMap = subFolder
            ? Object.fromEntries(
                subFolder.children
                  .filter((c): c is VariableEntry => !isFolder(c))
                  .map((c) => [c.display_name, c]),
              )
            : undefined;
          const nestedChildFolders = subFolder
            ? Object.fromEntries(
                subFolder.children
                  .filter((c): c is FolderEntry => isFolder(c))
                  .map((c) => [c.name, c]),
              )
            : undefined;
          return (
            <div key={`${name}-${i}`}>
              <div className="editor-binding-req-row editor-binding-req-row--folder">
                <span className="editor-binding-req-row__name">{name}</span>
                {showFolderSlot && (
                  <span
                    className={`editor-binding-char-row__match-slot${folderMatched ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
                  >
                    {folderMatched ? '✓' : '✗'}
                  </span>
                )}
              </div>
              <div className="editor-binding-tree-children">
                <RequiredFieldTree
                  fields={nested}
                  childMap={nestedChildMap}
                  childFolders={nestedChildFolders}
                />
              </div>
            </div>
          );
        }
        const matched = childMap?.[name];
        const showMatchSlot = childMap !== undefined;
        const typeMatches =
          !expectedType ||
          (matched ? accepts(parseTypeToken(expectedType), nodeVarType(matched)) : false);
        const accessGood = !needsWrite || (matched ? matched.writable === true : false);
        const isMatched = matched !== undefined && typeMatches && accessGood;
        return (
          <div key={`${name}-${i}`} className="editor-binding-req-row">
            <span className="editor-binding-req-row__name">{name}</span>
            {showMatchSlot && (
              <span
                className={`editor-binding-char-row__match-slot${isMatched ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
              >
                {isMatched ? '✓' : '✗'}
              </span>
            )}
            <span className="editor-binding-char-row__type">
              {expectedType ?? matched?.data_type ?? '—'}
            </span>
            {needsWrite ? (
              <AccessBadge writable={true} />
            ) : (
              <AccessBadge writable={false} readOnlyLabel="RO / RW" />
            )}
          </div>
        );
      })}
    </>
  );
}

function TypeBadge({ type }: { type: string }) {
  return <span className="editor-binding-char-row__type cfg-text-truncate">{type}</span>;
}

function StructSchemaTree({
  nodes,
  requiredNames,
}: {
  nodes: StructSchemaNode[];
  requiredNames?: Set<string>;
}) {
  return (
    <>
      {nodes.map((n, i) => {
        const isUnused = requiredNames !== undefined && !requiredNames.has(n.name);
        if (n.kind === 'folder' || n.kind === 'array') {
          return (
            <div key={`${n.name}-${i}`}>
              <div
                className={`editor-binding-char-row editor-binding-char-row--folder${isUnused ? ' editor-binding-char-row--unused' : ''}`}
              >
                <span className="editor-binding-char-row__name">{n.name}</span>
                {n.kind === 'array' && <span className="editor-binding-char-row__type">array</span>}
              </div>
              {n.children && n.children.length > 0 && (
                <div className="editor-binding-tree-children">
                  <StructSchemaTree nodes={n.children} />
                </div>
              )}
            </div>
          );
        }
        return (
          <div
            key={`${n.name}-${i}`}
            className={`editor-binding-char-row${isUnused ? ' editor-binding-char-row--unused' : ''}`}
          >
            <span className="editor-binding-char-row__name">{n.name}</span>
            {n.type && <span className="editor-binding-char-row__type">{n.type}</span>}
            {n.write !== undefined && <AccessBadge writable={n.write} />}
          </div>
        );
      })}
    </>
  );
}

// ── RightPanel modes & props ─────────────────────────────────────────────────

/** Schema-field shape consumed by the var-mode panels. */
interface SchemaField {
  type?: string | string[];
  label?: string;
  requiredFields?: RequiredFieldEntry[];
  write?: boolean;
}

export interface ComponentPropSelectedItem {
  propKey: string;
  propSchema: ComponentPropertySchema;
  node: StructSchemaNode | null;
  structNodes: StructSchemaNode[] | null;
  displayLabel: ReactNode;
}

export interface VarMode {
  schemaField: SchemaField | null;
  selectedVar: VariableEntry | null;
  selectedParentVar: VariableEntry | null;
  selectedElementIndex?: number;
  rawSelectedFolder: FolderEntry | null;
  scalarIsValid: boolean | null;
  isStruct: boolean;
}

export interface ComponentPropMode {
  fieldType?: string | string[];
  requiredFields?: RequiredFieldEntry[];
  requiredNamesSet?: Set<string>;
  isStructTarget: boolean;
  typeIsOk: boolean | null;
  selectedItem: ComponentPropSelectedItem | null;
}

interface RightPanelProps {
  pickerTitle: string;
  selectedKey: string | null;
  /** Exactly one of `varMode` / `componentPropMode` is non-null at any time. */
  varMode: VarMode | null;
  componentPropMode: ComponentPropMode | null;
}

export default function RightPanel({
  pickerTitle,
  selectedKey,
  varMode,
  componentPropMode,
}: RightPanelProps) {
  if (componentPropMode) {
    return (
      <ComponentPropPanel
        pickerTitle={pickerTitle}
        selectedKey={selectedKey}
        mode={componentPropMode}
      />
    );
  }
  if (varMode?.isStruct && varMode.schemaField?.requiredFields) {
    return <VarStructPanel mode={varMode} />;
  }
  return <VarScalarPanel pickerTitle={pickerTitle} mode={varMode} />;
}

function ComponentPropPanel({
  pickerTitle,
  selectedKey,
  mode,
}: {
  pickerTitle: string;
  selectedKey: string | null;
  mode: ComponentPropMode;
}) {
  const { fieldType, requiredFields, requiredNamesSet, isStructTarget, typeIsOk, selectedItem } =
    mode;
  return (
    <div className="editor-binding-col2">
      <div className="editor-binding-right editor-binding-right--stacked">
        <div className="editor-binding-right__label">Required</div>
        <div className="editor-binding-requirements">
          {isStructTarget ? (
            <>
              <div className="editor-binding-req-row editor-binding-req-row--parent">
                <span className="editor-binding-req-row__name">{pickerTitle}</span>
                {typeIsOk !== null && (
                  <span
                    className={`editor-binding-char-row__match-slot${typeIsOk ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
                  >
                    {typeIsOk ? '✓' : '✗'}
                  </span>
                )}
              </div>
              {requiredFields?.length ? (
                <div className="editor-binding-children-group">
                  <RequiredFieldsTree
                    fields={requiredFields}
                    propNodes={selectedItem?.structNodes ?? undefined}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="editor-binding-req-row">
              <span className="editor-binding-req-row__name">{pickerTitle}</span>
              {typeIsOk !== null && (
                <span
                  className={`editor-binding-char-row__match-slot${typeIsOk ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
                >
                  {typeIsOk ? '✓' : '✗'}
                </span>
              )}
              {fieldType !== undefined && <TypeBadge type={formatTypeBadge(fieldType)} />}
            </div>
          )}
        </div>
      </div>
      <div className="editor-binding-mid">
        <div className="editor-binding-mid__label">Selected property</div>
        <div className="editor-binding-characteristics">
          {selectedItem && selectedKey ? (
            <>
              <div className="editor-binding-req-row editor-binding-req-row--parent">
                <span className="editor-binding-req-row__name">{selectedItem.displayLabel}</span>
                {!isStructTarget && !selectedItem.node && (
                  <TypeBadge type={formatTypeBadge(selectedItem.propSchema.type)} />
                )}
                {selectedItem.node?.kind === 'variable' && (
                  <>
                    {selectedItem.node.type && <TypeBadge type={selectedItem.node.type} />}
                    <AccessBadge writable={selectedItem.node.write} />
                  </>
                )}
              </div>
              {selectedItem.structNodes?.length ? (
                <div className="editor-binding-children-group">
                  <StructSchemaTree
                    nodes={selectedItem.structNodes}
                    requiredNames={requiredNamesSet}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <div className="editor-binding-char-empty">Nothing selected</div>
          )}
        </div>
      </div>
    </div>
  );
}

function VarStructPanel({ mode }: { mode: VarMode }) {
  const { schemaField, selectedVar, rawSelectedFolder } = mode;
  const requiredFields = schemaField?.requiredFields;
  if (!requiredFields) return null;
  const childByName = rawSelectedFolder
    ? Object.fromEntries(
        rawSelectedFolder.children
          .filter((c): c is VariableEntry => !isFolder(c))
          .map((c) => [c.display_name, c]),
      )
    : undefined;
  const childFoldersByName = rawSelectedFolder
    ? Object.fromEntries(
        rawSelectedFolder.children
          .filter((c): c is FolderEntry => isFolder(c))
          .map((c) => [c.name, c]),
      )
    : undefined;
  return (
    <div className="editor-binding-col2">
      <div className="editor-binding-right editor-binding-right--stacked">
        <div className="editor-binding-right__label">Required</div>
        <div className="editor-binding-requirements">
          <div className="editor-binding-req-row editor-binding-req-row--parent">
            <span className="editor-binding-req-row__name">
              {schemaField?.label ?? 'Required fields'}
            </span>
          </div>
          <div className="editor-binding-children-group">
            <RequiredFieldTree
              fields={requiredFields}
              childMap={childByName}
              childFolders={childFoldersByName}
            />
          </div>
        </div>
      </div>
      <div className="editor-binding-mid">
        <div className="editor-binding-mid__label">Selected variable</div>
        <div className="editor-binding-characteristics">
          {selectedVar ? (
            <SelectedVarRow entry={selectedVar} />
          ) : rawSelectedFolder ? (
            <SelectedFolderRow folder={rawSelectedFolder} requiredFields={requiredFields} />
          ) : (
            <div className="editor-binding-char-empty">Nothing selected</div>
          )}
        </div>
      </div>
    </div>
  );
}

function VarScalarPanel({ pickerTitle, mode }: { pickerTitle: string; mode: VarMode | null }) {
  const schemaField = mode?.schemaField ?? null;
  const selectedVar = mode?.selectedVar ?? null;
  const selectedParentVar = mode?.selectedParentVar ?? null;
  const selectedElementIndex = mode?.selectedElementIndex;
  const rawSelectedFolder = mode?.rawSelectedFolder ?? null;
  const scalarIsValid = mode?.scalarIsValid ?? null;
  return (
    <div className="editor-binding-col2">
      <div className="editor-binding-right editor-binding-right--stacked">
        <div className="editor-binding-right__label">Required</div>
        <div className="editor-binding-requirements">
          <div className="editor-binding-req-row">
            <span className="editor-binding-req-row__name">
              {schemaField?.label ?? pickerTitle}
            </span>
            {scalarIsValid !== null && (
              <span
                className={`editor-binding-char-row__match-slot${scalarIsValid ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
              >
                {scalarIsValid ? '✓' : '✗'}
              </span>
            )}
            {schemaField?.type !== undefined && acceptedValueTypes(schemaField.type).length > 0 && (
              <span className="editor-binding-char-row__type">
                {acceptedValueTypes(schemaField.type).join(' / ')}
              </span>
            )}
            {schemaField?.write === true ? (
              <AccessBadge writable={true} />
            ) : (
              <AccessBadge writable={false} readOnlyLabel="RO / RW" />
            )}
          </div>
        </div>
      </div>
      <div className="editor-binding-mid">
        <div className="editor-binding-mid__label">Selected variable</div>
        <div className="editor-binding-characteristics">
          {selectedVar ? (
            <SelectedVarRow entry={selectedVar} />
          ) : selectedParentVar !== null && selectedElementIndex !== undefined ? (
            <SelectedVarRow entry={selectedParentVar} elementIndex={selectedElementIndex} />
          ) : rawSelectedFolder ? (
            <SelectedFolderRow
              folder={rawSelectedFolder}
              requiredFields={schemaField?.requiredFields}
            />
          ) : (
            <div className="editor-binding-char-empty">Nothing selected</div>
          )}
        </div>
      </div>
    </div>
  );
}
