import { describe, expect, it } from 'vitest';
import coercionCases from '../types/__fixtures__/opcuaWriteCoercion.json';
import typeFixture from '../types/__fixtures__/opcuaWriteTypes.json';
import {
  canonicalOpcuaWriteType,
  coerceOpcuaWrite,
  OPCUA_WRITE_TYPE_MATRIX,
} from './opcuaWriteCoercion';

describe('OPC-UA write type matrix', () => {
  it('matches the cross-language raw type fixture', () => {
    const actual: Record<string, string[]> = {};
    for (const [rawType, rule] of Object.entries(OPCUA_WRITE_TYPE_MATRIX)) {
      (actual[rule.canonical] ??= []).push(rawType);
    }
    for (const values of Object.values(actual)) values.sort();
    const expected = Object.fromEntries(
      Object.entries(typeFixture).map(([canonical, rawTypes]) => [canonical, [...rawTypes].sort()]),
    );
    expect(actual).toEqual(expected);
  });

  it.each(coercionCases)('$name', (testCase) => {
    const result = coerceOpcuaWrite(testCase.value, {
      dataType: testCase.dataType,
      isArray: 'isArray' in testCase ? testCase.isArray : undefined,
      arrayLength: 'arrayLength' in testCase ? testCase.arrayLength : undefined,
    });
    expect(result.ok).toBe(testCase.ok);
    if (testCase.ok && result.ok && 'output' in testCase)
      expect(result.value).toEqual(testCase.output);
    if (!testCase.ok && !result.ok) expect(result.reason).toBe(testCase.reason);
  });

  it('classifies raw aliases without widening unknown types', () => {
    expect(canonicalOpcuaWriteType('UInt32')).toBe('Integer');
    expect(canonicalOpcuaWriteType('Timespan')).toBe('Duration');
    expect(canonicalOpcuaWriteType('LocalizedText')).toBeNull();
  });

  it('bounds pathological integer strings before BigInt conversion', () => {
    expect(coerceOpcuaWrite('9'.repeat(5001), { dataType: 'UInt64' })).toEqual({
      ok: false,
      reason: 'integer_out_of_range',
    });
  });

  it.each([undefined, 0, -1])('treats indexed array length %s as dynamic', (arrayLength) => {
    expect(
      coerceOpcuaWrite(7, {
        dataType: 'Int16',
        isArray: true,
        arrayLength,
        indexed: true,
        arrayIndex: 5,
      }),
    ).toEqual({ ok: true, value: 7 });
  });

  describe('configured range enforcement', () => {
    it('accepts a value within min/max', () => {
      expect(coerceOpcuaWrite(5, { dataType: 'Float', min: -20, max: 10 })).toEqual({
        ok: true,
        value: 5,
      });
    });

    it('rejects a value below min', () => {
      expect(coerceOpcuaWrite(-21, { dataType: 'Float', min: -20, max: 10 })).toEqual({
        ok: false,
        reason: 'value_out_of_range',
      });
    });

    it('rejects a value above max', () => {
      expect(coerceOpcuaWrite(11, { dataType: 'Float', min: -20, max: 10 })).toEqual({
        ok: false,
        reason: 'value_out_of_range',
      });
    });

    it('treats bounds as inclusive', () => {
      expect(coerceOpcuaWrite(-20, { dataType: 'Float', min: -20, max: 10 }).ok).toBe(true);
      expect(coerceOpcuaWrite(10, { dataType: 'Float', min: -20, max: 10 }).ok).toBe(true);
    });

    it('is unaffected when no range is configured', () => {
      expect(coerceOpcuaWrite(1_000_000, { dataType: 'Float' }).ok).toBe(true);
    });

    it('leaves an invalid persisted min > max unenforced', () => {
      expect(coerceOpcuaWrite(1_000_000, { dataType: 'Float', min: 10, max: -20 }).ok).toBe(true);
    });

    it('rejects a whole-array write with any out-of-range element', () => {
      expect(
        coerceOpcuaWrite([1, 2, 101], { dataType: 'Int32', isArray: true, min: 0, max: 100 }),
      ).toEqual({ ok: false, reason: 'value_out_of_range' });
    });

    it('rejects an indexed element write out of range', () => {
      expect(
        coerceOpcuaWrite(101, {
          dataType: 'Int32',
          isArray: true,
          indexed: true,
          arrayIndex: 0,
          min: 0,
          max: 100,
        }),
      ).toEqual({ ok: false, reason: 'value_out_of_range' });
    });
  });
});
