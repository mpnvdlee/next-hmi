import {
  componentPropFits,
  componentPropVerdict,
  structSchemaNodeFits,
  structSchemaNodeVerdict,
  type PropSlot,
} from '@config/components/editor/VariableBindingPicker/componentPropHelpers';
import fitsFixture from './__fixtures__/componentPropFits.json';
import schemaFieldFixture from './__fixtures__/componentPropertySchemaField.json';
import {
  componentPropertyToSchemaField,
  type ComponentPropertySchema,
  type StructSchemaNode,
  typeLabel,
} from './componentProperty';

describe('componentPropertyToSchemaField — select option types', () => {
  it('maps a select with no option type to a string dropdown, as it always has', () => {
    const prop: ComponentPropertySchema = {
      type: 'select',
      label: 'Mode',
      options: [{ label: 'Auto', value: 'auto' }],
    };

    expect(componentPropertyToSchemaField(prop)).toMatchObject({
      type: 'string',
      format: 'select',
    });
  });

  it('gives a numeric select the number base type, so numeric sources still fit it', () => {
    const prop: ComponentPropertySchema = {
      type: 'select',
      label: 'Size',
      optionType: 'integer',
      options: [{ label: 'Small', value: 10 }],
    };

    expect(componentPropertyToSchemaField(prop)).toMatchObject({
      type: 'integer',
      format: 'select',
    });
  });

  it('gives a boolean select the boolean base type', () => {
    const prop: ComponentPropertySchema = {
      type: 'select',
      label: 'Direction',
      optionType: 'boolean',
      options: [{ label: 'Forward', value: true }],
    };

    expect(componentPropertyToSchemaField(prop)).toMatchObject({
      type: 'boolean',
      format: 'select',
    });
  });

  it('gives a localisable select the string base type, since a translation resolves to text', () => {
    const prop: ComponentPropertySchema = {
      type: 'select',
      label: 'Caption',
      optionType: 'loc',
      options: [{ label: 'Running', value: { $loc: 'status.running' } }],
    };

    expect(componentPropertyToSchemaField(prop)).toMatchObject({
      type: 'string',
      format: 'select',
    });
  });

  it('keeps the authoring-only option type out of the schema field', () => {
    const prop: ComponentPropertySchema = {
      type: 'select',
      label: 'Size',
      optionType: 'float',
      options: [],
    };

    expect(componentPropertyToSchemaField(prop)).not.toHaveProperty('optionType');
  });
});

describe('typeLabel', () => {
  it.each([
    ['float', 'Float'],
    ['integer[]', 'Integer[]'],
    ['datetime', 'DateTime'],
    ['struct', 'Struct'],
    ['struct[]', 'Struct[]'],
    ['select', 'Select (enum)'],
    ['Double', 'Double'],
    ['Motor', 'Motor'],
  ])('shows %s as %s', (token, label) => {
    expect(typeLabel(token)).toBe(label);
  });
});

// Shared with backend/tests/test_structure_parity.py, which holds the backend's
// port of both functions (core/validation/component_property.py) to them.
describe('component property parity fixtures', () => {
  it.each(schemaFieldFixture)('converts: $name', ({ input, output }) => {
    expect(componentPropertyToSchemaField(input as ComponentPropertySchema)).toEqual(output);
  });

  it.each(
    fitsFixture as {
      name: string;
      prop?: unknown;
      node?: unknown;
      slot: unknown;
      fits: boolean;
      verdict: { ok: boolean; reason?: string };
    }[],
  )('fits: $name', ({ prop, node, slot, fits, verdict }) => {
    if (prop) {
      expect(componentPropFits(prop as ComponentPropertySchema, slot as PropSlot)).toBe(fits);
      expect(componentPropVerdict(prop as ComponentPropertySchema, slot as PropSlot)).toEqual(
        verdict,
      );
    } else {
      expect(structSchemaNodeFits(node as StructSchemaNode, slot as PropSlot)).toBe(fits);
      expect(structSchemaNodeVerdict(node as StructSchemaNode, slot as PropSlot)).toEqual(verdict);
    }
  });
});
