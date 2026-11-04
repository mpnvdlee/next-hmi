import { renderSchemaField } from '../../../../utils/renderSchemaField';
import PropRow from '../../../ui/PropRow';
import BoolButtonGroup from '../../../ui/BoolButtonGroup';
import { BranchEditor } from './shared';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import { FORMULA_OPERAND_SLOT, FORMULA_OPERAND_TYPES, type OpenBindingPicker } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { FormulaSource } from '@shared/types/config';
import { formulaWildcardKeys, parseFormula } from '@hmi/utils/formula';

const OPERAND_SCHEMA: SchemaField = { type: FORMULA_OPERAND_TYPES, label: '' };
// The guide this build ships, or the public one of its version — see /help.
const FORMULA_DOCS_URL = '/help/properties.html#calculate-with-a-formula-formula';
const EXPRESSION_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Formula',
  placeholder: '({1} - 32) / 1.8',
};

export function FormulaEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const parent = useParentPath();
  const formulaObj = (value as FormulaSource)?.$formula ?? { expression: '', wildcards: {} };
  const expression = formulaObj.expression ?? '';
  const wildcards: Record<string, unknown> = formulaObj.wildcards ?? {};
  const keys = formulaWildcardKeys(expression);
  const invalid = expression.trim() !== '' && parseFormula(expression) === null;

  function updateWildcard(key: string, wcValue: unknown) {
    onChange({ $formula: { ...formulaObj, wildcards: { ...wildcards, [key]: wcValue } } });
  }

  function handleExpressionChange(next: string) {
    const nextWildcards: Record<string, unknown> = {};
    for (const k of formulaWildcardKeys(next)) nextWildcards[k] = wildcards[k] ?? 0;
    onChange({ $formula: { ...formulaObj, expression: next, wildcards: nextWildcards } });
  }

  return (
    <div className="cfg-string-expr">
      <div className="cfg-string-expr__template">
        {renderSchemaField(EXPRESSION_SCHEMA, expression, (v) =>
          handleExpressionChange(String(v ?? '')),
        )}
      </div>

      {/* The link carries the syntax; the hint stays one line. */}
      <p
        className={`cfg-prop-hint${invalid ? ' cfg-prop-hint--error' : ''}`}
        role={invalid ? 'alert' : undefined}
      >
        {invalid ? (
          'This formula is not valid — the value stays empty until it is fixed.'
        ) : (
          <>
            Use <code>{'{1}'}</code>, <code>{'{2}'}</code>, … for values.
          </>
        )}{' '}
        <a href={FORMULA_DOCS_URL} target="_blank" rel="noreferrer">
          Formula reference
        </a>
      </p>

      {keys.map((key) => (
        <ParentPathContext.Provider
          key={key}
          value={withSegs(parent, '$formula', 'wildcards', key)}
        >
          <BranchEditor
            label={`{${key}}`}
            value={wildcards[key] ?? 0}
            onChange={(v) => updateWildcard(key, v)}
            schema={OPERAND_SCHEMA}
            slot={FORMULA_OPERAND_SLOT}
            onOpenBindingPicker={onOpenBindingPicker}
          />
        </ParentPathContext.Provider>
      ))}

      <PropRow label="Round to a whole number">
        <BoolButtonGroup
          value={formulaObj.round === true}
          onChange={(v) => onChange({ $formula: { ...formulaObj, round: v } })}
        />
      </PropRow>
    </div>
  );
}
