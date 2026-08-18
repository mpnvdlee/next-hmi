/**
 * RequiredFieldsTree — the "Required" field list shown by the binding picker's
 * right panel, and by the component-property editor for a struct property's
 * schema. `propNodes` is the struct actually on offer: pass it to get the
 * per-field ✓/✗ match slots, omit it to render the requirement on its own.
 */

import AccessBadge from '@config/components/ui/AccessBadge';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import {
  rfName,
  rfType,
  rfNeedsWrite,
  rfNestedFields,
  type RequiredFieldEntry,
} from '../bindingPickerUtils';
import { structSchemaMatchesRequired } from './helpers';

export default function RequiredFieldsTree({
  fields,
  propNodes,
}: {
  fields: RequiredFieldEntry[];
  propNodes?: StructSchemaNode[];
}) {
  return (
    <>
      {fields.map((f, i) => {
        const name = rfName(f);
        const nested = rfNestedFields(f);
        const expectedType = rfType(f);
        const needsWrite = rfNeedsWrite(f);
        const matchNode = propNodes?.find((n) => n.name === name);
        const showSlot = propNodes !== undefined;
        if (nested?.length) {
          const subNodes =
            matchNode?.kind === 'folder' || matchNode?.kind === 'array'
              ? (matchNode.children ?? [])
              : undefined;
          const folderMatched =
            matchNode !== undefined && structSchemaMatchesRequired(subNodes ?? [], nested);
          return (
            <div key={`${name}-${i}`}>
              <div className="editor-binding-req-row editor-binding-req-row--folder">
                <span className="editor-binding-req-row__name">{name}</span>
                {showSlot && (
                  <span
                    className={`editor-binding-char-row__match-slot${folderMatched ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
                  >
                    {folderMatched ? '✓' : '✗'}
                  </span>
                )}
              </div>
              <div className="editor-binding-tree-children">
                <RequiredFieldsTree fields={nested} propNodes={subNodes} />
              </div>
            </div>
          );
        }
        const typeMatches =
          !expectedType ||
          !matchNode?.type ||
          matchNode.type.toLowerCase() === expectedType.toLowerCase();
        const accessGood = !needsWrite || matchNode?.write === true;
        const isMatched = matchNode !== undefined && typeMatches && accessGood;
        return (
          <div key={`${name}-${i}`} className="editor-binding-req-row">
            <span className="editor-binding-req-row__name">{name}</span>
            {showSlot && (
              <span
                className={`editor-binding-char-row__match-slot${isMatched ? '' : ' editor-binding-char-row__match-slot--mismatch'}`}
              >
                {isMatched ? '✓' : '✗'}
              </span>
            )}
            <span className="editor-binding-char-row__type">{expectedType ?? '—'}</span>
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
