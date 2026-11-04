import { describe, expect, it } from 'vitest';
import syntax from '@shared/types/__fixtures__/formulaSyntax.json';
import { evaluateFormula, parseFormula } from './formula';

function run(expression: string, values: Record<string, number | null> = {}): number | null {
  const node = parseFormula(expression);
  if (!node) throw new Error(`does not parse: ${expression}`);
  return evaluateFormula(node, (key) => values[key] ?? null);
}

describe('formula syntax', () => {
  // The backend's formula-invalid diagnostic reads the same fixture
  // (backend/core/validation/structure.py, test_structure_parity.py).
  it.each(syntax.valid)('parses %s', (expression) => {
    expect(parseFormula(expression)).not.toBeNull();
  });

  it.each(syntax.invalid)('refuses %s', (expression) => {
    expect(parseFormula(expression)).toBeNull();
  });
});

describe('formula evaluation', () => {
  it('keeps arithmetic and its precedence', () => {
    expect(run('({1} - 32) / 1.8', { 1: 212 })).toBe(100);
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('1 / {1}', { 1: 0 })).toBeNull();
  });

  it('reads one bit of a placeholder, the sign bit of a negative one too', () => {
    expect(run('{1}.3', { 1: 0b1000 })).toBe(1);
    expect(run('{1}.2', { 1: 0b1000 })).toBe(0);
    expect(run('{1}.31', { 1: -1 })).toBe(1);
    expect(run('{1}.0', { 1: 1.5 })).toBeNull();
  });

  it('masks, shifts and reads hex and binary literals', () => {
    expect(run('{1} AND 16#0C', { 1: 0b1110 })).toBe(0b1100);
    expect(run('SHR({1}, 4) AND 16#0F', { 1: 0x6a })).toBe(6);
    expect(run('SHL(1, 31)')).toBe(2 ** 31);
    expect(run('2#1100_0000 OR 1')).toBe(193);
    expect(run('5 XOR 1')).toBe(4);
    expect(run('NOT 0 AND 16#FF')).toBe(255);
  });

  it('binds AND tighter than XOR, XOR tighter than OR, arithmetic tighter than all', () => {
    expect(run('1 OR 2 AND 0')).toBe(1);
    expect(run('3 XOR 1 OR 4')).toBe(6);
    expect(run('1 + 1 AND 2')).toBe(2);
  });

  it('leaves the value empty for a bit operation on a fraction or a wild shift', () => {
    expect(run('1.5 AND 1')).toBeNull();
    expect(run('SHL(1, -1)')).toBeNull();
    expect(run('SHL(1, 64)')).toBeNull();
    expect(run('SHL(1, 60)')).toBeNull();
  });
});
