import { useState } from 'react';
import AddButton from '../../../ui/AddButton';
import FieldGroup from '../../../ui/FieldGroup';
import { ClearIcon } from '../../../ui/actionIcons';
import { BranchEditor, CompareFields, KindLabel, PreviewText, SwitchCasePreview } from './shared';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import { COMPARE_OPERAND_SCHEMA, type Operator, type OpenBindingPicker, wrapPicker } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { CompareSource, IfSource, SwitchSource } from '@shared/types/config';
import { primaryType } from '@shared/utils/valueTypes';

const IF_CONDITION_SCHEMA: SchemaField = { type: 'Boolean', label: 'Condition' };

/**
 * $if — condition + true/false outputs.
 * The condition is any boolean expression (e.g. $compare, $pageIsActive, $var).
 */
export function IfEditor({
  value,
  onChange,
  schema,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const ifObj = (value as IfSource)?.$if ?? {
    condition: null,
    true: '',
    false: '',
  };
  const parent = useParentPath();

  return (
    <>
      <ParentPathContext.Provider value={withSegs(parent, '$if', 'condition')}>
        <BranchEditor
          label="Condition"
          value={ifObj.condition}
          onChange={(v) => onChange({ $if: { ...ifObj, condition: v } })}
          schema={IF_CONDITION_SCHEMA}
          onOpenBindingPicker={onOpenBindingPicker}
        />
      </ParentPathContext.Provider>

      {schema && (
        <>
          <ParentPathContext.Provider value={withSegs(parent, '$if', 'true')}>
            <BranchEditor
              label="When True"
              value={ifObj.true}
              onChange={(v) => onChange({ $if: { ...ifObj, true: v } })}
              schema={schema}
              onOpenBindingPicker={onOpenBindingPicker}
            />
          </ParentPathContext.Provider>
          <ParentPathContext.Provider value={withSegs(parent, '$if', 'false')}>
            <BranchEditor
              label="When False"
              value={ifObj.false}
              onChange={(v) => onChange({ $if: { ...ifObj, false: v } })}
              schema={schema}
              onOpenBindingPicker={onOpenBindingPicker}
            />
          </ParentPathContext.Provider>
        </>
      )}
    </>
  );
}

/** $compare — left variable OP right value, returns boolean. */
export function CompareEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const cmpObj = (value as CompareSource)?.$compare ?? {
    left: { $var: { path: '' } },
    operator: '>',
    right: 0,
  };

  function patch(p: Partial<typeof cmpObj>) {
    onChange({ $compare: { ...cmpObj, ...p } });
  }

  const openLeftPicker = wrapPicker(
    onOpenBindingPicker,
    (b) => patch({ left: { $var: b } }),
    cmpObj.left,
  );
  const openRightPicker = wrapPicker(
    onOpenBindingPicker,
    (b) => patch({ right: { $var: b } }),
    cmpObj.right,
  );
  const parent = useParentPath();

  return (
    <ParentPathContext.Provider value={withSegs(parent, '$compare')}>
      <CompareFields
        left={cmpObj.left}
        operator={(cmpObj.operator as Operator) ?? '>'}
        right={cmpObj.right}
        onChangeLeft={(v) => patch({ left: v })}
        onChangeOperator={(op) => patch({ operator: op })}
        onChangeRight={(r) => patch({ right: r })}
        onOpenLeftPicker={openLeftPicker}
        onOpenRightPicker={openRightPicker}
      />
    </ParentPathContext.Provider>
  );
}

/**
 * One `$switch` case. Collapsed it previews `when = then`; expanded it holds
 * both branch editors inline, so a case is edited where it sits instead of in
 * a detached pair of fields under the list (same shape as an action row).
 */
function SwitchCaseRow({
  index,
  entry,
  parent,
  schema,
  expanded,
  onExpandedChange,
  onPatch,
  onRemove,
  onOpenBindingPicker,
}: {
  index: number;
  entry: { when: unknown; then: unknown };
  parent: string[] | undefined;
  schema?: SchemaField;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onPatch: (patch: { when?: unknown; then?: unknown }) => void;
  onOpenBindingPicker?: OpenBindingPicker;
  onRemove: () => void;
}) {
  const casePath = withSegs(parent, '$switch', 'cases', String(index));
  const title = `Case ${index + 1}`;
  const thenFieldType = schema ? primaryType(schema.type) : undefined;

  return (
    <FieldGroup
      tier={3}
      kindLabel={<KindLabel>{title}</KindLabel>}
      summary={
        <PreviewText>
          <SwitchCasePreview when={entry.when} then={entry.then} fieldType={thenFieldType} />
        </PreviewText>
      }
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      actions={
        <button
          type="button"
          className="cfg-row-action-btn cfg-row-action-btn--stretch"
          title="Remove case"
          onClick={onRemove}
        >
          <ClearIcon />
        </button>
      }
    >
      <ParentPathContext.Provider value={withSegs(casePath, 'when')}>
        <BranchEditor
          label="When"
          value={entry.when}
          onChange={(v) => onPatch({ when: v })}
          schema={COMPARE_OPERAND_SCHEMA}
          onOpenBindingPicker={onOpenBindingPicker}
        />
      </ParentPathContext.Provider>
      {schema && (
        <ParentPathContext.Provider value={withSegs(casePath, 'then')}>
          <BranchEditor
            label="Then"
            value={entry.then}
            onChange={(v) => onPatch({ then: v })}
            schema={schema}
            onOpenBindingPicker={onOpenBindingPicker}
          />
        </ParentPathContext.Provider>
      )}
    </FieldGroup>
  );
}

/** $switch — expression variable + cases list + default. */
export function SwitchEditor({
  value,
  onChange,
  schema,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  schema?: SchemaField;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const switchObj = (value as SwitchSource)?.$switch ?? {
    value: null,
    cases: [],
    default: '',
  };
  const parent = useParentPath();

  // One case open at a time — the row itself hosts the editors, so expanding a
  // second would push the first far off screen inside a narrow panel.
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const expressionPicker = wrapPicker(
    onOpenBindingPicker,
    (b) => onChange({ $switch: { ...switchObj, value: { $var: b } } }),
    switchObj.value,
  );

  function addCase() {
    const cases = [...switchObj.cases, { when: '', then: '' }];
    onChange({ $switch: { ...switchObj, cases } });
    setExpandedIdx(cases.length - 1);
  }

  function removeCase(idx: number) {
    const cases = switchObj.cases.filter((_, i) => i !== idx);
    onChange({ $switch: { ...switchObj, cases } });
    setExpandedIdx(null);
  }

  function patchCase(idx: number, patch: { when?: unknown; then?: unknown }) {
    const cases = switchObj.cases.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onChange({ $switch: { ...switchObj, cases } });
  }

  return (
    <>
      <ParentPathContext.Provider value={withSegs(parent, '$switch', 'value')}>
        <BranchEditor
          label="Expression"
          value={switchObj.value ?? null}
          onChange={(v) => onChange({ $switch: { ...switchObj, value: v } })}
          schema={COMPARE_OPERAND_SCHEMA}
          onOpenBindingPicker={expressionPicker}
        />
      </ParentPathContext.Provider>

      {/* Same shell as the action list and the alarm resolutions: the add
          control sits behind the title, and each entry is one collapsible row
          that carries its own editors. */}
      <div className="cfg-editor-actions cfg-switch-cases">
        <div className="cfg-editor-actions__title-row">
          <span className="cfg-field-group__label">Cases</span>
          <AddButton title="Add case" onClick={addCase}>
            + Add case
          </AddButton>
        </div>

        {switchObj.cases.length === 0 ? (
          <div className="cfg-switch-empty">No cases yet</div>
        ) : (
          switchObj.cases.map((c, idx) => (
            <SwitchCaseRow
              key={idx}
              index={idx}
              entry={c}
              parent={parent}
              schema={schema}
              expanded={expandedIdx === idx}
              onExpandedChange={(next) => setExpandedIdx(next ? idx : null)}
              onPatch={(patch) => patchCase(idx, patch)}
              onRemove={() => removeCase(idx)}
              onOpenBindingPicker={onOpenBindingPicker}
            />
          ))
        )}
      </div>

      {schema && (
        <ParentPathContext.Provider value={withSegs(parent, '$switch', 'default')}>
          <BranchEditor
            label="Default"
            value={switchObj.default}
            onChange={(v) => onChange({ $switch: { ...switchObj, default: v } })}
            schema={schema}
            onOpenBindingPicker={onOpenBindingPicker}
          />
        </ParentPathContext.Provider>
      )}
    </>
  );
}
