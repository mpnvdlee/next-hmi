/**
 * Guards the custom-widget SDK contract against drift.
 *
 * `custom-widgets-sdk.d.ts` lives outside `tsconfig.json`'s `include` (on
 * purpose — its declarations are globals, and pulling them into the app's
 * scope would collide with the real `useState`, `React`, `LayoutConfig`, …).
 * The cost of staying outside is that nothing type-checks it, so it drifted:
 * it declared a grid-era `LayoutConfig` with `columns` / `colSpan` / `rowSpan`
 * that no longer exist, while omitting `padding` / `margin` / `radius` /
 * `width` / `height`, which do. A widget author got completion for fields
 * `selfLayoutStyle` ignores, and type errors on the fields it honours.
 *
 * `nextHmiSdk.ts` already fails loudly at boot when a name in `SDK_NAMES` is
 * missing from `window.__nextHMI__`. These tests cover the half it can't see.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_NAMES } from './nextHmiSdkNames';

const FRONTEND_ROOT = join(__dirname, '..', '..', '..');
const SDK_DTS = readFileSync(join(FRONTEND_ROOT, 'custom-widgets-sdk.d.ts'), 'utf-8');

/** Strip block and line comments so their prose can't be read as declarations. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Field names declared directly on an interface body — brace/paren/angle aware,
 * so a multi-line function-typed member's parameters aren't mistaken for
 * fields of the interface.
 */
function interfaceFields(source: string, name: string): Set<string> | null {
  const header = new RegExp(`(?:^|\\n)(?:export |declare )?interface ${name}\\s*\\{`).exec(source);
  if (!header) return null;

  const start = header.index + header[0].length;
  let depth = 1;
  let end = start;
  for (; end < source.length && depth > 0; end++) {
    const ch = source[end];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }

  const body = source.slice(start, end - 1);
  const fields = new Set<string>();
  let nesting = 0;
  let token = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') nesting++;
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') nesting--;
    else if (nesting === 0) {
      if (/[A-Za-z0-9_$]/.test(ch)) {
        token += ch;
        continue;
      }
      // `name:` or `name?:` at the top level of the body is a field.
      if (token && (ch === ':' || (ch === '?' && body[i + 1] === ':'))) fields.add(token);
      if (!/\s/.test(ch)) token = '';
      else if (ch === '\n') token = '';
      continue;
    }
    token = '';
  }
  return fields;
}

const DTS = stripComments(SDK_DTS);

describe('custom-widget SDK declarations', () => {
  it('declares every name the compiler injects', () => {
    const declared = new Set(
      [...DTS.matchAll(/^declare (?:function|const|var|let|namespace)\s+([A-Za-z_]\w*)/gm)].map(
        (m) => m[1],
      ),
    );

    const missing = SDK_NAMES.filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  /**
   * `nextHmiSdk.ts` derives its type from the object literal, so `tsc` catches a
   * missing or extra key — but not a reordering. Two lists a human maintains by
   * hand are far easier to diff when they read in the same order, and the
   * backend's mirror (`test_widget_compiler_sdk_names.py`) is already
   * order-sensitive against `SDK_NAMES`.
   */
  it('assigns the names in SDK_NAMES order', () => {
    const source = readFileSync(join(FRONTEND_ROOT, 'src', 'nextHmiSdk.ts'), 'utf-8');
    const literal = /export const nextHmiSdk = \{([\s\S]*?)\n\};/.exec(source);
    expect(literal, 'nextHmiSdk object literal not found').not.toBeNull();

    const assigned = [...stripComments(literal![1]).matchAll(/^ {2}(\w+)[,:]/gm)].map((m) => m[1]);
    expect(assigned).toEqual([...SDK_NAMES]);
  });
});

/**
 * `.d.ts` interface → the source module whose exported interface of the same
 * name it mirrors. Fields listed in `omit` are deliberately withheld from the
 * SDK; everything else must match exactly in both directions, so a phantom
 * field is as much a failure as a missing one.
 */
const MIRRORED: { name: string; module: string; omit?: string[] }[] = [
  { name: 'LayoutConfig', module: 'shared/types/config.ts' },
  {
    name: 'HmiWidgetProps',
    module: 'shared/types/config.ts',
    // Built-in containers only — see the field's comment in the source.
    omit: ['childConfigs'],
  },
  { name: 'VariableBinding', module: 'shared/types/config.ts' },
  { name: 'WriteVariableOptions', module: 'hmi/hooks/useWriteVariable.ts' },
  { name: 'WriteVariable', module: 'hmi/hooks/useWriteVariable.ts' },
  { name: 'AckAlarmOptions', module: 'hmi/components/alarmUtils.ts' },
  { name: 'ActionsConfig', module: 'shared/types/config.ts' },
  { name: 'SchemaField', module: 'shared/types/widgetSchema.ts' },
  { name: 'RecipeParameter', module: 'shared/types/recipe.ts' },
  { name: 'RecipeDataset', module: 'shared/types/recipe.ts' },
  { name: 'RecipeDatasetType', module: 'shared/types/recipe.ts' },
  { name: 'EvaluationContext', module: 'hmi/utils/propertySourceEval.ts' },
  { name: 'AlarmInstance', module: 'shared/types/alarm.ts' },
  { name: 'AlarmSummary', module: 'shared/types/alarm.ts' },
];

describe.each(MIRRORED)('$name mirrors its source interface', ({ name, module, omit }) => {
  it('declares the same fields, and no others', () => {
    const source = stripComments(readFileSync(join(FRONTEND_ROOT, 'src', module), 'utf-8'));
    const real = interfaceFields(source, name);
    const declared = interfaceFields(DTS, name);

    expect(real, `${name} not found in src/${module}`).not.toBeNull();
    expect(declared, `${name} not found in custom-widgets-sdk.d.ts`).not.toBeNull();

    for (const field of omit ?? []) real!.delete(field);

    expect([...declared!].sort()).toEqual([...real!].sort());
  });
});
