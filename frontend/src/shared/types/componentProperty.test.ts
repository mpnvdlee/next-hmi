import { componentPropertyToSchemaField, type ComponentPropertySchema } from './componentProperty';

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
