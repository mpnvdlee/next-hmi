import sourceOffersFixture from '@shared/types/__fixtures__/sourceOffers.json';
import {
  PROPERTY_SOURCES,
  SCALAR_FIELD_TYPES,
  producedFits,
  type ProducedValueType,
} from './propertySourceRegistry';
import {
  getDefaultPropertySources,
  getAllowedPropertySources,
  isPropertySourceAllowed,
  PROPERTY_SOURCE_KEYS,
  SOURCE_CAPABLE_TYPES,
} from './propertySourceRules';

describe('propertySourceRules', () => {
  it('returns correct default sources for string type', () => {
    const sources = getDefaultPropertySources('string');
    expect(sources).toContain('$var');
    expect(sources).toContain('$loc');
    expect(sources).toContain('$time');
    expect(sources).not.toContain('$random');
  });

  it('returns correct default sources for number type', () => {
    const sources = getDefaultPropertySources('float');
    expect(sources).toContain('$var');
    expect(sources).toContain('$random');
    // boolean-producing sources are not coercible to a number field
    expect(sources).not.toContain('$pageIsActive');
    expect(sources).not.toContain('$compare');
    expect(sources).not.toContain('$loc');
  });

  it('returns correct default sources for boolean type', () => {
    const sources = getDefaultPropertySources('boolean');
    expect(sources).toContain('$compare');
    expect(sources).toContain('$pageIsActive');
    expect(sources).not.toContain('$random');
    expect(sources).not.toContain('$loc');
  });

  it('offers a field-selecting source where one of its choices fits', () => {
    expect(getDefaultPropertySources('integer')).toContain('$page');
    expect(getDefaultPropertySources('integer')).toContain('$viewport');
    expect(getDefaultPropertySources('boolean')).toContain('$recipe');
    expect(getDefaultPropertySources('boolean')).not.toContain('$page');
    expect(getDefaultPropertySources('boolean')).not.toContain('$viewport');
    expect(getDefaultPropertySources('integer')).not.toContain('$user');
    expect(getDefaultPropertySources('integer')).not.toContain('$device');
  });

  it('offers a source only where its produced type is the field type', () => {
    expect(getDefaultPropertySources('integer')).not.toContain('$formula');
    expect(getDefaultPropertySources('float')).not.toContain('$alarmCount');
    expect(getDefaultPropertySources('string')).not.toContain('$compare');
    expect(getDefaultPropertySources('datetime')).not.toContain('$stringExpr');
    expect(getDefaultPropertySources('datetime')).toContain('$time');
    expect(getDefaultPropertySources('integer')).toContain('$random');
  });

  it('offers a number-producing source on a duration field', () => {
    const sources = getDefaultPropertySources('duration');
    expect(sources).toContain('$formula');
    expect(sources).toContain('$alarmCount');
    expect(sources).not.toContain('$stringExpr');
  });

  it('offers a video field the same sources as an image field', () => {
    expect(getDefaultPropertySources('video')).toEqual(getDefaultPropertySources('image'));
    expect(getDefaultPropertySources('video')).toContain('$static');
    expect(getDefaultPropertySources('video')).toContain('$urlParam');
  });

  it('returns empty for non-value-source types', () => {
    expect(getDefaultPropertySources('struct')).toEqual([]);
    expect(getDefaultPropertySources('actions')).toEqual([]);
    expect(getDefaultPropertySources('variable')).toEqual([]);
  });

  it('derives allowed sources from field type alone', () => {
    const allowed = getAllowedPropertySources('string');
    expect(allowed).toContain('$loc');
    expect(allowed).toContain('$var');
  });

  it('returns empty allowed sources for non-value-source types', () => {
    expect(getAllowedPropertySources('struct')).toEqual([]);
    expect(getAllowedPropertySources('actions')).toEqual([]);
  });

  it('validates source type compatibility', () => {
    // $random is valid for number
    expect(isPropertySourceAllowed('float', '$random').valid).toBe(true);

    // $random is invalid for string
    expect(isPropertySourceAllowed('string', '$random').valid).toBe(false);

    // $loc is valid for string
    expect(isPropertySourceAllowed('string', '$loc').valid).toBe(true);

    // $loc is invalid for number
    expect(isPropertySourceAllowed('float', '$loc').valid).toBe(false);
  });

  it('offers the record-list array producers and excludes static', () => {
    const allowed = getAllowedPropertySources('record-list');
    expect(allowed).toContain('$recipeList');
    expect(allowed).toContain('$var');
    expect(allowed).toContain('$widgetProp');
    expect(allowed).not.toContain('$static');
  });

  it('never leaks the record-list producer onto scalar fields', () => {
    for (const t of ['string', 'float', 'integer', 'boolean', 'datetime']) {
      expect(getAllowedPropertySources(t)).not.toContain('$recipeList');
    }
  });

  it('contains all 26 valid source types', () => {
    expect(PROPERTY_SOURCE_KEYS).toHaveLength(26);
    expect(PROPERTY_SOURCE_KEYS).toContain('$static');
    expect(PROPERTY_SOURCE_KEYS).toContain('$var');
    expect(PROPERTY_SOURCE_KEYS).toContain('$loc');
    expect(PROPERTY_SOURCE_KEYS).toContain('$urlParam');
    expect(PROPERTY_SOURCE_KEYS).toContain('$pageIsActive');
    expect(PROPERTY_SOURCE_KEYS).toContain('$if');
    expect(PROPERTY_SOURCE_KEYS).toContain('$compare');
    expect(PROPERTY_SOURCE_KEYS).toContain('$not');
    expect(PROPERTY_SOURCE_KEYS).toContain('$formula');
    expect(PROPERTY_SOURCE_KEYS).toContain('$random');
    expect(PROPERTY_SOURCE_KEYS).toContain('$switch');
    expect(PROPERTY_SOURCE_KEYS).toContain('$user');
    expect(PROPERTY_SOURCE_KEYS).toContain('$userGroups');
    expect(PROPERTY_SOURCE_KEYS).toContain('$device');
    expect(PROPERTY_SOURCE_KEYS).toContain('$time');
    expect(PROPERTY_SOURCE_KEYS).toContain('$widgetProp');
    expect(PROPERTY_SOURCE_KEYS).toContain('$page');
    expect(PROPERTY_SOURCE_KEYS).toContain('$viewport');
    expect(PROPERTY_SOURCE_KEYS).toContain('$languages');
    expect(PROPERTY_SOURCE_KEYS).toContain('$stringExpr');
    expect(PROPERTY_SOURCE_KEYS).toContain('$http');
    expect(PROPERTY_SOURCE_KEYS).toContain('$alarmCount');
    expect(PROPERTY_SOURCE_KEYS).toContain('$recipe');
    expect(PROPERTY_SOURCE_KEYS).toContain('$recipeList');
    expect(PROPERTY_SOURCE_KEYS).toContain('$componentProp');
    expect(PROPERTY_SOURCE_KEYS).toContain('$result');
  });
});

describe('source offers fixture', () => {
  // The backend's source-type diagnostic reads the same matrix
  // (backend/core/validation/source_rules.py, test_structure_parity.py).
  it('lists the sources every source-capable type offers', () => {
    expect(
      Object.fromEntries([...SOURCE_CAPABLE_TYPES].map((t) => [t, getDefaultPropertySources(t)])),
    ).toEqual(sourceOffersFixture.offers);
  });

  it('offers on a union field every source any of its types offers', () => {
    for (const c of sourceOffersFixture.unionOffers) {
      expect(getAllowedPropertySources(c.fieldType), c.fieldType.join(' | ')).toEqual(c.offers);
    }
  });

  it('allows a source on a union field when any of its types offers it', () => {
    expect(isPropertySourceAllowed(['float', 'integer'], '$alarmCount').valid).toBe(true);
    expect(isPropertySourceAllowed('float', '$alarmCount').valid).toBe(false);
  });

  it("lists every source's produced types", () => {
    expect(
      Object.fromEntries(
        PROPERTY_SOURCE_KEYS.map((k) => [
          k,
          PROPERTY_SOURCES[k === '$static' ? 'static' : k].produces,
        ]),
      ),
    ).toEqual(sourceOffersFixture.produces);
  });

  it('fits a produced type to the same scalar type only, a number to a duration too', () => {
    const fits = Object.fromEntries(
      Object.keys(sourceOffersFixture.fits).map((p) => [
        p,
        SCALAR_FIELD_TYPES.filter((t) => producedFits(p as ProducedValueType, t)),
      ]),
    );
    expect(fits).toEqual(sourceOffersFixture.fits);
  });
});
