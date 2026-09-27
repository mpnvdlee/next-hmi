import sourceOffersFixture from '@shared/types/__fixtures__/sourceOffers.json';
import sourceProducesFixture from '@shared/types/__fixtures__/sourceProduces.json';
import {
  PROPERTY_SOURCES,
  SOURCE_FIELD_PRODUCES,
  createSourceDefault,
  sourceFieldFits,
  type FieldSelectingSource,
} from './propertySourceRegistry';

describe('SOURCE_FIELD_PRODUCES', () => {
  it('matches the shared fixture', () => {
    expect(SOURCE_FIELD_PRODUCES).toEqual(sourceProducesFixture);
  });

  it("is what each field-selecting source produces, in the fields' order", () => {
    for (const [source, fields] of Object.entries(SOURCE_FIELD_PRODUCES)) {
      const union = [...new Set(Object.values(fields).flat())];
      expect(PROPERTY_SOURCES[source as keyof typeof SOURCE_FIELD_PRODUCES].produces).toEqual(
        union,
      );
    }
  });
});

describe('sourceFieldFits', () => {
  it('fits a choice to the field type its value serves', () => {
    expect(sourceFieldFits('$page', 'depth', 'Integer')).toBe(true);
    expect(sourceFieldFits('$page', 'title', 'Integer')).toBe(false);
    expect(sourceFieldFits('$viewport', 'size', 'integer')).toBe(false);
    expect(sourceFieldFits('$recipe', 'activeName', 'Boolean')).toBe(false);
    expect(sourceFieldFits('$recipe', 'loaded', 'Boolean')).toBe(true);
  });

  it('fits a choice to its own type only, a number to a duration too', () => {
    expect(sourceFieldFits('$recipe', 'loaded', 'String')).toBe(false);
    expect(sourceFieldFits('$page', 'depth', 'Float')).toBe(false);
    expect(sourceFieldFits('$page', 'depth', 'Duration')).toBe(true);
    expect(sourceFieldFits('$page', 'title', 'DateTime')).toBe(false);
  });

  it('matches the shared fit cases', () => {
    for (const c of sourceOffersFixture.fieldFits) {
      expect(
        sourceFieldFits(c.source as FieldSelectingSource, c.field, c.fieldType),
        `${c.source} ${c.field} on ${c.fieldType}`,
      ).toBe(c.fits);
    }
  });

  it('fits a string choice to a string-valued editor kind and a list to a list kind', () => {
    expect(sourceFieldFits('$page', 'icon', 'icon')).toBe(true);
    expect(sourceFieldFits('$page', 'depth', 'icon')).toBe(false);
    expect(sourceFieldFits('$user', 'userList', 'option-list')).toBe(true);
    expect(sourceFieldFits('$user', 'username', 'option-list')).toBe(false);
  });

  it('fits the user list to a text field, which joins the names, but not to a number', () => {
    expect(sourceFieldFits('$user', 'userList', 'String')).toBe(true);
    expect(sourceFieldFits('$user', 'userList', 'Integer')).toBe(false);
    expect(sourceFieldFits('$user', 'groups', 'option-list')).toBe(true);
  });

  it('never fits a choice the table does not know', () => {
    expect(sourceFieldFits('$page', 'nonsense', 'String')).toBe(false);
  });
});

describe('createDefault on a field-selecting source', () => {
  it('keeps the usual choice where it fits', () => {
    expect(createSourceDefault('$page', 'String')).toEqual({ $page: { field: 'title' } });
    expect(createSourceDefault('$viewport', 'string')).toEqual({ $viewport: { field: 'size' } });
  });

  it('starts on the first choice that fits otherwise', () => {
    expect(createSourceDefault('$page', 'Integer')).toEqual({ $page: { field: 'depth' } });
    expect(createSourceDefault('$viewport', 'integer')).toEqual({ $viewport: { field: 'width' } });
    expect(createSourceDefault('$user', 'option-list')).toEqual({ $user: { field: 'userList' } });
    expect(createSourceDefault('$page', 'icon')).toEqual({ $page: { field: 'icon' } });
  });

  it('starts on a choice that fits any type of a union', () => {
    expect(createSourceDefault('$viewport', ['float', 'integer'])).toEqual({
      $viewport: { field: 'width' },
    });
    expect(createSourceDefault('$page', ['Float', 'Integer'])).toEqual({
      $page: { field: 'depth' },
    });
  });

  it("shapes a union field's default value by its first type", () => {
    expect(createSourceDefault('static', ['float', 'integer'])).toBe(0);
  });
});
