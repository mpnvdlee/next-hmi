import {
  accepts,
  canonicalBase,
  elementOf,
  formatVarType,
  nodeAcceptsOrElement,
  nodeVarType,
  parseTypeToken,
  type VarType,
} from './varType';
import parityFixture from './__fixtures__/varTypeAccepts.json';

interface ParityCase {
  name: string;
  varType: VarType;
  acceptTokens: string[];
  requiredFields?: Array<string | { name: string }>;
  expected: boolean;
}

describe('parseTypeToken', () => {
  it('parses scalar and array scalar tokens (case-insensitive)', () => {
    expect(parseTypeToken('float')).toEqual({ kind: 'scalar', base: 'Float', array: false });
    expect(parseTypeToken('string[]')).toEqual({ kind: 'scalar', base: 'String', array: true });
    expect(parseTypeToken('INTEGER')).toEqual({ kind: 'scalar', base: 'Integer', array: false });
  });

  it('treats unknown/struct names as struct accepts', () => {
    expect(parseTypeToken('Alarm')).toEqual({ kind: 'struct', array: false });
    expect(parseTypeToken('Alarm[]')).toEqual({ kind: 'struct', array: true });
    expect(parseTypeToken('struct')).toEqual({ kind: 'struct', array: false });
  });
});

describe('canonicalBase', () => {
  it('canonicalises simple-type names (case-insensitive) and falls back to String', () => {
    expect(canonicalBase('integer')).toBe('Integer');
    expect(canonicalBase('Float')).toBe('Float');
    // Raw OPC-UA names are already simplified upstream, so they are not canonical here.
    expect(canonicalBase('int16')).toBe('String');
    expect(canonicalBase('weird')).toBe('String');
  });
});

describe('elementOf', () => {
  it('drops array-ness, identity on scalars', () => {
    const arr: VarType = { kind: 'scalar', base: 'Integer', array: true, length: 6 };
    expect(elementOf(arr)).toEqual({ kind: 'scalar', base: 'Integer', array: false });
    const scalar: VarType = { kind: 'scalar', base: 'Integer', array: false };
    expect(elementOf(scalar)).toBe(scalar);
  });
});

describe('accepts (strict)', () => {
  const stringArray: VarType = { kind: 'scalar', base: 'String', array: true };
  const intScalar: VarType = { kind: 'scalar', base: 'Integer', array: false };

  it('matches a String[] variable to a string[] slot (Dropdown options)', () => {
    expect(accepts(parseTypeToken('string[]'), stringArray)).toBe(true);
  });

  it('matches an indexed Integer[] element to an integer slot (ValueDisplay)', () => {
    const elem = elementOf({ kind: 'scalar', base: 'Integer', array: true });
    expect(accepts(parseTypeToken('integer'), elem)).toBe(true);
  });

  it('rejects a whole array bound to a scalar slot', () => {
    expect(
      accepts(parseTypeToken('integer'), { kind: 'scalar', base: 'Integer', array: true }),
    ).toBe(false);
  });

  it('rejects a base mismatch and a scalar-vs-struct mismatch', () => {
    expect(accepts(parseTypeToken('float'), intScalar)).toBe(false);
    expect(accepts(parseTypeToken('struct'), intScalar)).toBe(false);
  });

  it('checks required-field subset for structs (only when fields are known)', () => {
    const withFields: VarType = {
      kind: 'struct',
      name: 'A',
      array: false,
      fields: ['id', 'label'],
    };
    const emptyFields: VarType = { kind: 'struct', name: 'A', array: false, fields: [] };
    expect(accepts(parseTypeToken('struct'), withFields, ['id'])).toBe(true);
    expect(accepts(parseTypeToken('struct'), withFields, ['missing'])).toBe(false);
    // Zero known fields (e.g. empty struct[]) is still accepted.
    expect(accepts(parseTypeToken('struct'), emptyFields, ['id'])).toBe(true);
  });
});

describe('nodeAcceptsOrElement (picker leniency)', () => {
  it('shows a scalar array under a scalar slot (drill into element)', () => {
    const arrNode = nodeVarType({ data_type: 'Integer', is_array: true, array_length: 6 });
    expect(nodeAcceptsOrElement(parseTypeToken('integer'), arrNode)).toBe(true);
    // Direct strict accept would reject it.
    expect(accepts(parseTypeToken('integer'), arrNode)).toBe(false);
  });

  it('does not show a scalar under an array slot', () => {
    const scalarNode = nodeVarType({ data_type: 'Integer' });
    expect(nodeAcceptsOrElement(parseTypeToken('integer[]'), scalarNode)).toBe(false);
  });
});

describe('accepts (shared parity fixture)', () => {
  // Same fixture drives backend/tests/test_vartype.py — a divergence there
  // fails that side instead of here.
  for (const c of parityFixture as ParityCase[]) {
    it(c.name, () => {
      const result = c.acceptTokens.some((token) =>
        accepts(parseTypeToken(token), c.varType, c.requiredFields),
      );
      expect(result).toBe(c.expected);
    });
  }
});

describe('nodeVarType / formatVarType', () => {
  it('derives a VarType from a node and formats it', () => {
    const t = nodeVarType({ data_type: 'Integer', is_array: true, array_length: 6 });
    expect(t).toEqual({ kind: 'scalar', base: 'Integer', array: true, length: 6 });
    expect(formatVarType(t)).toBe('Integer[]');
  });

  it('derives a struct VarType from a struct node', () => {
    const t = nodeVarType({ data_type: 'struct', fields: { id: 'Integer', label: 'String' } });
    expect(t).toEqual({ kind: 'struct', name: 'struct', array: false, fields: ['id', 'label'] });
    expect(formatVarType(t)).toBe('struct');
  });
});
