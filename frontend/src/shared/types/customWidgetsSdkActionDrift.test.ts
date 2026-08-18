/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG_TS_PATH = path.resolve(__dirname, 'config.ts');
const SDK_DTS_PATH = path.resolve(__dirname, '../../../custom-widgets-sdk.d.ts');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Slices out a top-level `type X = <union>;` alias by brace depth, so it stops at
 *  the alias's own terminating `;` rather than the first `;` inside a member. */
function extractUnionBlock(source: string, blockStart: string): string {
  const startIdx = source.indexOf(blockStart);
  if (startIdx === -1) throw new Error(`marker not found: ${blockStart}`);
  const from = startIdx + blockStart.length;
  let depth = 0;
  let end = source.length;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ';' && depth === 0) {
      end = i;
      break;
    }
  }
  return source.slice(from, end);
}

/** Splits a discriminated union block into `{ variantName -> field names }` by
 *  anchoring on each member's `type: '...'` literal — the only place `type:`
 *  appears in this union — since a full TS parser is overkill for a drift check. */
function extractVariants(block: string): Map<string, Set<string>> {
  const typeRe = /type:\s*'([^']+)'/g;
  const anchors = [...block.matchAll(typeRe)];
  const variants = new Map<string, Set<string>>();
  anchors.forEach((anchor, i) => {
    const name = anchor[1];
    const chunkStart = anchor.index! + anchor[0].length;
    const chunkEnd = i + 1 < anchors.length ? anchors[i + 1].index! : block.length;
    const chunk = block.slice(chunkStart, chunkEnd);
    const fields = new Set<string>();
    const fieldRe = /(\w+)\s*\??\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(chunk))) fields.add(m[1]);
    variants.set(name, fields);
  });
  return variants;
}

function parseVariants(filePath: string, blockStart: string): Map<string, Set<string>> {
  const source = stripComments(fs.readFileSync(filePath, 'utf-8'));
  return extractVariants(extractUnionBlock(source, blockStart));
}

// Guards against `custom-widgets-sdk.d.ts`'s `ComponentAction` (the widget-authoring
// SDK's ambient type, not compiled/type-checked by esbuild) silently drifting from
// the real `ButtonAction` union in config.ts as new action variants/fields are added.
describe('custom-widgets-sdk.d.ts action drift', () => {
  const buttonActionVariants = parseVariants(CONFIG_TS_PATH, 'export type ButtonAction =');
  const componentActionVariants = parseVariants(SDK_DTS_PATH, 'type ComponentAction =');

  it('parsed at least the known ButtonAction variants', () => {
    expect(buttonActionVariants.size).toBeGreaterThanOrEqual(13);
  });

  it('declares the same action variant names as ButtonAction', () => {
    expect([...componentActionVariants.keys()].sort()).toEqual(
      [...buttonActionVariants.keys()].sort(),
    );
  });

  it('mirrors every field of each ButtonAction variant', () => {
    for (const [name, fields] of buttonActionVariants) {
      const sdkFields = componentActionVariants.get(name);
      expect(sdkFields, `custom-widgets-sdk.d.ts is missing action type '${name}'`).toBeDefined();
      expect([...sdkFields!].sort()).toEqual([...fields].sort());
    }
  });
});
