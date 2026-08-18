import { describe, it, expect } from 'vitest';
import {
  toSimpleType,
  representativeOpcuaType,
  canonicalOpcuaType,
  baseType,
  isArrayType,
  isScalarType,
  isEditorKind,
  isStructType,
  isNumericType,
  typeList,
  primaryType,
  acceptedValueTypes,
  EDITOR_KINDS,
} from './valueTypes';
import editorKindsFixture from '../types/__fixtures__/editorKinds.json';

describe('EDITOR_KINDS', () => {
  it('matches the shared fixture also read by backend/core/validation/structure.py', () => {
    expect([...EDITOR_KINDS]).toEqual(editorKindsFixture);
  });
});

describe('toSimpleType', () => {
  it('maps real OPC-UA types to value types', () => {
    expect(toSimpleType('Boolean')).toBe('Boolean');
    expect(toSimpleType('Bool')).toBe('Boolean');
    expect(toSimpleType('Int32')).toBe('Integer');
    expect(toSimpleType('UInt64')).toBe('Integer');
    expect(toSimpleType('Double')).toBe('Float');
    expect(toSimpleType('Single')).toBe('Float');
    expect(toSimpleType('ByteString')).toBe('String');
    expect(toSimpleType('DateTime')).toBe('DateTime');
  });

  it('is case-insensitive and idempotent', () => {
    expect(toSimpleType('iNt32')).toBe('Integer');
    expect(toSimpleType('float')).toBe('Float');
    expect(toSimpleType('Float')).toBe('Float');
    expect(toSimpleType('datetime')).toBe('DateTime');
  });

  it('falls back to String for unknown/empty', () => {
    expect(toSimpleType('Mystery')).toBe('String');
    expect(toSimpleType(undefined)).toBe('String');
  });
});

describe('representativeOpcuaType', () => {
  it('maps simple types to representative OPC-UA types', () => {
    expect(representativeOpcuaType('integer')).toBe('Int32');
    expect(representativeOpcuaType('float')).toBe('Double');
    expect(representativeOpcuaType('boolean')).toBe('Boolean');
    expect(representativeOpcuaType('string')).toBe('String');
    expect(representativeOpcuaType('datetime')).toBe('DateTime');
  });

  it('round-trips back to the same value type', () => {
    for (const t of ['Integer', 'Float', 'Boolean', 'String', 'DateTime']) {
      expect(toSimpleType(representativeOpcuaType(t))).toBe(t);
    }
  });
});

describe('canonicalOpcuaType', () => {
  it('keeps known OPC-UA types (case-insensitive)', () => {
    expect(canonicalOpcuaType('Int16')).toBe('Int16');
    expect(canonicalOpcuaType('uint32')).toBe('UInt32');
    expect(canonicalOpcuaType('DOUBLE')).toBe('Double');
  });

  it('resolves aliases', () => {
    expect(canonicalOpcuaType('Bool')).toBe('Boolean');
    expect(canonicalOpcuaType('Int8')).toBe('SByte');
    expect(canonicalOpcuaType('UInt8')).toBe('Byte');
    expect(canonicalOpcuaType('Single')).toBe('Float');
  });

  it('falls back to Float for unknown/empty', () => {
    expect(canonicalOpcuaType('Mystery')).toBe('Float');
    expect(canonicalOpcuaType(undefined)).toBe('Float');
  });
});

describe('classifier', () => {
  it('baseType / isArrayType', () => {
    expect(baseType('float[]')).toBe('float');
    expect(baseType('float')).toBe('float');
    expect(isArrayType('Alarms[]')).toBe(true);
    expect(isArrayType('Alarms')).toBe(false);
  });

  it('isScalarType / isEditorKind / isStructType', () => {
    expect(isScalarType('integer')).toBe(true);
    expect(isScalarType('float[]')).toBe(true);
    expect(isScalarType('Alarms')).toBe(false);
    expect(isEditorKind('color')).toBe(true);
    expect(isEditorKind('option-list')).toBe(true);
    expect(isEditorKind('integer')).toBe(false);
    // A named struct is neither scalar nor editor kind.
    expect(isStructType('Alarms[]')).toBe(true);
    expect(isStructType('Motor')).toBe(true);
    expect(isStructType('struct')).toBe(true);
    expect(isStructType('float')).toBe(false);
    expect(isStructType('color')).toBe(false);
  });

  it('isNumericType', () => {
    expect(isNumericType('Integer')).toBe(true);
    expect(isNumericType('Float')).toBe(true);
    expect(isNumericType('Int32')).toBe(true);
    expect(isNumericType('Double')).toBe(true);
    expect(isNumericType('String')).toBe(false);
    expect(isNumericType('Boolean')).toBe(false);
    expect(isNumericType('DateTime')).toBe(false);
  });

  it('typeList / primaryType / acceptedValueTypes', () => {
    expect(typeList('float')).toEqual(['float']);
    expect(typeList(['float', 'integer'])).toEqual(['float', 'integer']);
    expect(primaryType(['float', 'integer', 'boolean'])).toBe('float');
    // Editor kinds are dropped from the binding filter.
    expect(acceptedValueTypes(['option-list', 'string[]', 'integer[]'])).toEqual([
      'string[]',
      'integer[]',
    ]);
    expect(acceptedValueTypes('color')).toEqual([]);
    expect(acceptedValueTypes(['float', 'integer', 'boolean'])).toEqual([
      'float',
      'integer',
      'boolean',
    ]);
  });
});
