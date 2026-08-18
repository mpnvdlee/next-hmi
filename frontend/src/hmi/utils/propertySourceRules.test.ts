import {
  getDefaultPropertySources,
  getAllowedPropertySources,
  isPropertySourceAllowed,
  PROPERTY_SOURCE_KEYS,
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

  it('contains all 24 valid source types', () => {
    expect(PROPERTY_SOURCE_KEYS).toHaveLength(24);
    expect(PROPERTY_SOURCE_KEYS).toContain('$static');
    expect(PROPERTY_SOURCE_KEYS).toContain('$var');
    expect(PROPERTY_SOURCE_KEYS).toContain('$loc');
    expect(PROPERTY_SOURCE_KEYS).toContain('$urlParam');
    expect(PROPERTY_SOURCE_KEYS).toContain('$pageIsActive');
    expect(PROPERTY_SOURCE_KEYS).toContain('$if');
    expect(PROPERTY_SOURCE_KEYS).toContain('$compare');
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
