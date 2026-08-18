import { renderSchemaField } from '../../../../utils/renderSchemaField';
import { WildcardCard } from './shared';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import { wrapPicker, type OpenBindingPicker } from './utils';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { StringExprSource } from '@shared/types/config';
import type { PropertySource } from '../../propertyValueUtils';

/** Extract unique wildcard numbers from a template string. */
function extractWildcardKeys(template: string): string[] {
  const keys = new Set<string>();
  const re = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    let body = m[1].trim();
    while (true) {
      const fn = /^[A-Za-z]\w*\((.+)\)$/.exec(body);
      if (!fn) break;
      body = fn[1].trim();
    }
    if (/^\d+$/.test(body)) keys.add(body);
  }
  return Array.from(keys).sort((a, b) => Number(a) - Number(b));
}

const WILDCARD_SOURCES: PropertySource[] = ['static', '$var', '$loc'];
const WILDCARD_SCHEMA: SchemaField = { type: 'String', label: '' };
const TEMPLATE_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Template',
  placeholder: '{1} - {ToLower(2)}, {3}',
};

export function StringExprEditor({
  value,
  onChange,
  onOpenBindingPicker,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const parent = useParentPath();
  const exprObj = (value as StringExprSource)?.$stringExpr ?? { template: '', wildcards: {} };
  const template = exprObj.template ?? '';
  const wildcards: Record<string, unknown> = exprObj.wildcards ?? {};

  const keys = extractWildcardKeys(template);

  function updateWildcard(key: string, wcValue: unknown) {
    onChange({ $stringExpr: { ...exprObj, wildcards: { ...wildcards, [key]: wcValue } } });
  }

  function handleTemplateChange(newTemplate: string) {
    const newKeys = new Set(extractWildcardKeys(newTemplate));
    const next: Record<string, unknown> = {};
    for (const k of newKeys) {
      next[k] = wildcards[k] ?? '';
    }
    onChange({ $stringExpr: { template: newTemplate, wildcards: next } });
  }

  return (
    <div className="cfg-string-expr">
      <div className="cfg-string-expr__template">
        {renderSchemaField(TEMPLATE_SCHEMA, template, (v) => handleTemplateChange(String(v ?? '')))}
      </div>

      <p className="cfg-prop-hint">
        Use <code>{'{1}'}</code>, <code>{'{2}'}</code>, … as placeholders. Functions:{' '}
        <code>ToLower</code>, <code>ToUpper</code>, <code>Trim</code>, <code>Capitalize</code>,{' '}
        <code>Round</code>, <code>Round1</code>, <code>Round2</code>
        <br />
        Example: <code>{'{Trim(ToLower(1))}'}</code>
      </p>

      {keys.map((key) => {
        const wcValue = wildcards[key] ?? '';
        const wcPicker = wrapPicker(
          onOpenBindingPicker,
          (b) => updateWildcard(key, { $var: b }),
          wcValue,
        );

        const path = withSegs(parent, '$stringExpr', 'wildcards', key);
        return (
          <ParentPathContext.Provider key={key} value={path}>
            <WildcardCard
              wcKey={key}
              value={wcValue}
              onChange={(v) => updateWildcard(key, v)}
              onOpenBindingPicker={wcPicker}
              schema={WILDCARD_SCHEMA}
              forcedSources={WILDCARD_SOURCES}
            />
          </ParentPathContext.Provider>
        );
      })}
    </div>
  );
}
