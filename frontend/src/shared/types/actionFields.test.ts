/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import actionFields from './__fixtures__/actionFields.json';

// Every field of every `ButtonAction` variant, with what the backend checks it
// as (backend/core/validation/structure.py `ACTION_FIELDS`, held to this same
// fixture by test_structure_parity.py). Adding a field to the union fails here
// until the fixture — and so the backend table — says how to validate it.

/** `{ variant -> top-level field names }` of the `ButtonAction` union, read by
 *  brace depth so a field's own object type (`{ $componentProp: string }`)
 *  contributes no names. A shape this reader does not understand — a variant
 *  with no `type: '…'` literal, a quoted key, a variant joined with `&` or
 *  named by alias — throws rather than dropping fields unseen. */
function buttonActionFields(): Map<string, Set<string>> {
  const source = fs
    .readFileSync(path.resolve(__dirname, 'config.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const marker = 'export type ButtonAction =';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error('ButtonAction union not found');
  const variants = new Map<string, Set<string>>();
  let depth = 0;
  let fields: Set<string> | null = null;
  let name: string | null = null;
  const token = /[{};&]|['"][^'"]*['"]\s*\??\s*:|(\w+)\s*\??\s*:\s*(?:'([^']*)')?|\w+/g;
  token.lastIndex = start + marker.length;
  let m: RegExpExecArray | null;
  while ((m = token.exec(source))) {
    const t = m[0];
    if (t === '{') {
      depth++;
      if (depth === 1) {
        fields = new Set();
        name = null;
      }
    } else if (t === '}') {
      if (depth === 1) {
        if (!fields || !name) throw new Error('a ButtonAction variant has no `type` literal');
        variants.set(name, fields);
      }
      depth--;
    } else if (t === ';') {
      if (depth === 0) break;
    } else if (depth === 0) {
      throw new Error(`unrecognised ButtonAction union member near '${t}'`);
    } else if (depth === 1 && fields) {
      if (/^['"]/.test(t)) throw new Error(`quoted ButtonAction field ${t}`);
      if (m[1] === undefined) continue;
      if (m[1] === 'type' && m[2] !== undefined) name = m[2];
      else fields.add(m[1]);
    }
  }
  return variants;
}

describe('actionFields fixture', () => {
  const union = buttonActionFields();

  it('parsed the ButtonAction union', () => {
    expect(union.size).toBeGreaterThanOrEqual(14);
  });

  it('names every action type of the union', () => {
    expect(Object.keys(actionFields).sort()).toEqual([...union.keys()].sort());
  });

  it('names every field of each action type, and only those', () => {
    for (const [name, fields] of union) {
      const listed = (actionFields as Record<string, Record<string, string>>)[name];
      expect(Object.keys(listed ?? {}).sort(), name).toEqual([...fields].sort());
    }
  });
});
