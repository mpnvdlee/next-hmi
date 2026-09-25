import { renderSchemaField } from '../../../../utils/renderSchemaField';
import { BranchEditor } from './shared';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import type { OpenBindingPicker } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { FormulaSource } from '@shared/types/config';
import { formulaWildcardKeys, parseFormula } from '@hmi/utils/formula';

const OPERAND_SCHEMA: SchemaField = { type: 'Float', label: '' };
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
    onChange({ $formula: { expression: next, wildcards: nextWildcards } });
  }

  return (
    <div className="cfg-string-expr">
      <div className="cfg-string-expr__template">
        {renderSchemaField(EXPRESSION_SCHEMA, expression, (v) =>
          handleExpressionChange(String(v ?? '')),
        )}
      </div>

      {invalid ? (
        <p className="cfg-prop-hint cfg-prop-hint--error" role="alert">
          This formula is not valid — the value stays empty until it is fixed.
        </p>
      ) : (
        <p className="cfg-prop-hint">
          Use <code>{'{1}'}</code>, <code>{'{2}'}</code>, … for values, with <code>+</code>{' '}
          <code>-</code> <code>*</code> <code>/</code> and parentheses.
          <br />
          Dividing by zero, or a value that is not a number, leaves the result empty.
        </p>
      )}

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
            onOpenBindingPicker={onOpenBindingPicker}
          />
        </ParentPathContext.Provider>
      ))}
    </div>
  );
}
