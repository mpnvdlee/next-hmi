import { describe, expect, it } from 'vitest';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import {
  buildComponentPropRows,
  componentPropFits,
  structSchemaNodeFits,
} from './componentPropHelpers';

const properties: Record<string, ComponentPropertySchema> = {
  selectedRow: {
    label: 'Selected Row',
    type: 'struct',
    structSchema: [
      { kind: 'variable', name: 'Motor Speed', type: 'float' },
      { kind: 'variable', name: 'Pressure', type: 'float' },
    ],
  },
};

describe('buildComponentPropRows search', () => {
  it('matches all words across the owning component, property, and field path', () => {
    const rows = buildComponentPropRows(
      properties,
      undefined,
      undefined,
      'grid speed',
      true,
      new Set(),
      { searchPath: 'Production Grid comp-1' },
    );

    expect(rows.map((row) => row.kind)).toEqual([
      'component-prop',
      'component-prop-node',
      'component-prop-node',
    ]);
    expect(
      buildComponentPropRows(
        properties,
        undefined,
        undefined,
        'grid temperature',
        true,
        new Set(),
        { searchPath: 'Production Grid comp-1' },
      ),
    ).toEqual([]);
  });
});

describe('componentPropFits', () => {
  const prop = (type: string, extra: Partial<ComponentPropertySchema> = {}) => ({
    type,
    label: type,
    ...extra,
  });

  it('judges a property as a variable of its type would be judged', () => {
    expect(componentPropFits(prop('integer'), { fieldType: 'Float' })).toBe(false);
    expect(componentPropFits(prop('float'), { fieldType: 'Integer' })).toBe(false);
    expect(componentPropFits(prop('string'), { fieldType: 'color' })).toBe(true);
  });

  it('reads a select by the type its options hold', () => {
    expect(
      componentPropFits(prop('select', { optionType: 'integer' }), { fieldType: 'Integer' }),
    ).toBe(true);
    expect(componentPropFits(prop('select'), { fieldType: 'String' })).toBe(true);
    expect(componentPropFits(prop('select'), { fieldType: 'Integer' })).toBe(false);
  });

  it('fits an editor-kind property only to a field of that kind', () => {
    expect(componentPropFits(prop('icon'), { fieldType: 'icon' })).toBe(true);
    expect(componentPropFits(prop('icon'), { fieldType: 'String' })).toBe(false);
    expect(componentPropFits(prop('actions'), { fieldType: 'actions' })).toBe(true);
    expect(componentPropFits(prop('string'), { fieldType: 'actions' })).toBe(false);
  });

  it("checks a struct property's fields against the required ones", () => {
    const motor = prop('struct', {
      structSchema: [{ kind: 'variable', name: 'Speed', type: 'Integer' }],
    });
    expect(componentPropFits(motor, { fieldType: 'Motor', requiredFields: ['Speed'] })).toBe(true);
    expect(
      componentPropFits(motor, {
        fieldType: 'Motor',
        requiredFields: [{ name: 'Speed', type: 'Float', write: true }],
      }),
    ).toBe(false);
  });
});

describe('structSchemaNodeFits', () => {
  it('takes an untyped field on trust, except for a struct field', () => {
    expect(structSchemaNodeFits({ kind: 'variable', name: 'x' }, { fieldType: 'Float' })).toBe(
      true,
    );
    expect(structSchemaNodeFits({ kind: 'variable', name: 'x' }, { fieldType: 'Motor' })).toBe(
      false,
    );
  });

  it('fits an array row to an array field only', () => {
    const row = { kind: 'array' as const, name: 'Setpoints', type: 'Float' };
    expect(structSchemaNodeFits(row, { fieldType: 'float[]' })).toBe(true);
    expect(structSchemaNodeFits(row, { fieldType: 'Float' })).toBe(false);
  });
});
