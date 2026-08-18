import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { WidgetConfig } from '@shared/types/config';
import { commonSchemaOf, schemaFieldsCompatible } from './commonSchema';

const field = (over: Partial<SchemaField> = {}): SchemaField => ({
  type: 'String',
  label: 'Label',
  ...over,
});

function registerFake(type: string, schema: Record<string, SchemaField>): void {
  widgetRegistry[type] = {
    name: type,
    render: () => null,
    schema,
  } as unknown as (typeof widgetRegistry)[string];
}

const widget = (id: string, type: string, properties?: Record<string, unknown>): WidgetConfig => ({
  id,
  type,
  name: id,
  ...(properties ? { properties } : {}),
});

describe('schemaFieldsCompatible', () => {
  it('accepts fields differing only in presentation', () => {
    expect(
      schemaFieldsCompatible(
        field({ label: 'Text', description: 'a', group: 'A', defaultValue: 'x' }),
        field({ label: 'Caption', description: 'b', group: 'B', defaultValue: 'y' }),
      ),
    ).toBe(true);
  });

  it('rejects a different type, format, event or write access', () => {
    expect(schemaFieldsCompatible(field(), field({ type: 'Integer' }))).toBe(false);
    expect(schemaFieldsCompatible(field(), field({ format: 'select' }))).toBe(false);
    expect(schemaFieldsCompatible(field({ event: 'onPress' }), field({ event: 'onRelease' }))).toBe(
      false,
    );
    expect(schemaFieldsCompatible(field({ write: true }), field())).toBe(false);
  });

  it('rejects a different numeric range', () => {
    expect(
      schemaFieldsCompatible(
        field({ type: 'Integer', min: 0, max: 10 }),
        field({ type: 'Integer', min: 0, max: 5 }),
      ),
    ).toBe(false);
  });

  it('compares select option values but not their labels', () => {
    const a = field({
      format: 'select',
      options: [
        { label: 'On', value: 'on' },
        { label: 'Off', value: 'off' },
      ],
    });
    const sameValues = field({
      format: 'select',
      options: [
        { label: 'Enabled', value: 'on' },
        { label: 'Disabled', value: 'off' },
      ],
    });
    const otherValues = field({
      format: 'select',
      options: [
        { label: 'On', value: 'on' },
        { label: 'Off', value: 'never' },
      ],
    });

    expect(schemaFieldsCompatible(a, sameValues)).toBe(true);
    expect(schemaFieldsCompatible(a, otherValues)).toBe(false);
  });

  it('rejects fields revealed by different conditions', () => {
    const onSelect = field({ visibleWhen: { property: 'mode', equals: 'select' } });

    expect(schemaFieldsCompatible(onSelect, field())).toBe(false);
    expect(
      schemaFieldsCompatible(
        onSelect,
        field({ visibleWhen: { property: 'mode', equals: 'list' } }),
      ),
    ).toBe(false);
    expect(
      schemaFieldsCompatible(
        onSelect,
        field({ visibleWhen: { property: 'mode', equals: 'select' } }),
      ),
    ).toBe(true);
  });

  it('rejects struct fields requiring different sub-fields', () => {
    expect(
      schemaFieldsCompatible(
        field({ type: 'struct', requiredFields: [{ name: 'value', type: 'Float' }] }),
        field({ type: 'struct', requiredFields: [{ name: 'value', type: 'String' }] }),
      ),
    ).toBe(false);
  });
});

describe('commonSchemaOf', () => {
  beforeEach(() => {
    registerFake('FakeA', {
      label: field({ label: 'Label' }),
      count: field({ type: 'Integer', label: 'Count' }),
      onlyA: field({ label: 'Only A' }),
      items: field({ type: 'option-list', label: 'Items' }),
      body: field({ type: 'widgets', label: 'Body' }),
    });
    registerFake('FakeB', {
      label: field({ label: 'Caption' }),
      count: field({ type: 'Integer', label: 'Total' }),
      onlyB: field({ label: 'Only B' }),
    });
    registerFake('FakeC', {
      label: field({ type: 'Integer', label: 'Label' }),
    });
    registerFake('FakeD', {
      label: field({ label: 'Label', visibleWhen: { property: 'count', equals: 1 } }),
      count: field({ type: 'Integer', label: 'Count' }),
    });
  });

  it('keeps every key when the widgets share a type', () => {
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('b', 'FakeA')]);

    expect(result.keys).toEqual(['label', 'count', 'onlyA']);
  });

  it('keeps only the keys both types declare compatibly', () => {
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('b', 'FakeB')]);

    expect(result.keys).toEqual(['label', 'count']);
  });

  it('drops a key the other widget declares with a different type', () => {
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('c', 'FakeC')]);

    expect(result.keys).toEqual([]);
  });

  it('drops a key the other widget only reveals under a condition', () => {
    // The panel evaluates the lead's `visibleWhen` against every widget, so a key
    // whose conditions differ would be offered where the other widget hides it.
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('d', 'FakeD')]);

    expect(result.keys).toEqual(['count']);
  });

  it('takes labels and order from the lead widget', () => {
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('b', 'FakeB')]);

    expect(result.schema.label.label).toBe('Label');
    expect(result.schema.count.label).toBe('Count');
  });

  it('excludes list editors that cannot be applied to many widgets', () => {
    const result = commonSchemaOf([widget('a', 'FakeA'), widget('a2', 'FakeA')]);

    expect(result.keys).not.toContain('items');
    // A slot row names one instance's own children — there is no such thing as
    // the same slot content across two of them.
    expect(result.keys).not.toContain('body');
  });

  it('returns nothing for an unknown widget type', () => {
    expect(commonSchemaOf([widget('x', 'NoSuchWidget'), widget('y', 'FakeA')]).keys).toEqual([]);
  });
});
