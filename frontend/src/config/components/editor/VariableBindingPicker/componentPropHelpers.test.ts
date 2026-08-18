import { describe, expect, it } from 'vitest';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { buildComponentPropRows } from './componentPropHelpers';

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
