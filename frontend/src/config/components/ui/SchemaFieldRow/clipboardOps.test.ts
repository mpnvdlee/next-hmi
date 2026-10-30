import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaField } from '@shared/types/widgetSchema';
import { pastePropertyValue } from './clipboardOps';

function clipboardHolds(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue(JSON.stringify(value)) },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('pastePropertyValue on a writing field', () => {
  const write: SchemaField = { type: 'float', label: 'Setpoint', write: true };

  it('takes a variable binding', async () => {
    const onChange = vi.fn();
    clipboardHolds({ $var: { path: 'PLC:Setpoint' } });
    await pastePropertyValue(write, 'Setpoint', onChange);
    expect(onChange).toHaveBeenCalledWith({ $var: { path: 'PLC:Setpoint' } });
  });

  it.each([
    ['a formula', { $formula: { expression: '{1} * 2', wildcards: { 1: 3 } } }],
    ['a fixed value', 4.5],
  ])('refuses %s', async (_what, value) => {
    const onChange = vi.fn();
    clipboardHolds(value);
    await pastePropertyValue(write, 'Setpoint', onChange);
    expect(onChange).not.toHaveBeenCalled();
  });
});
