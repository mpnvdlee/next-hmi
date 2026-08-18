export type WriteCoercionReason =
  | 'null_not_allowed'
  | 'unknown_type'
  | 'scalar_required'
  | 'array_required'
  | 'array_length_mismatch'
  | 'invalid_boolean'
  | 'invalid_integer'
  | 'integer_out_of_range'
  | 'lossy_conversion'
  | 'invalid_float'
  | 'non_finite_float'
  | 'invalid_string'
  | 'invalid_temporal'
  | 'float_out_of_range'
  | 'invalid_descriptor'
  | 'array_index_out_of_bounds'
  | 'value_out_of_range';

export interface OpcuaWriteDescriptor {
  dataType?: string;
  isArray?: boolean;
  arrayLength?: number | null;
  indexed?: boolean;
  arrayIndex?: number;
  /** Persisted variable range. A persisted min > max is a contract violation
   * and left unenforced, matching backend write_service. */
  min?: number;
  max?: number;
}

export type WriteCoercionResult =
  { ok: true; value: unknown } | { ok: false; reason: WriteCoercionReason };

interface TypeRule {
  canonical: 'Boolean' | 'Integer' | 'Float' | 'String' | 'DateTime' | 'Date' | 'Time' | 'Duration';
  min?: bigint;
  max?: bigint;
}

const INT_RANGES: Record<string, readonly [bigint, bigint]> = {
  sbyte: [-128n, 127n],
  int8: [-128n, 127n],
  byte: [0n, 255n],
  uint8: [0n, 255n],
  int16: [-32768n, 32767n],
  uint16: [0n, 65535n],
  int32: [-2147483648n, 2147483647n],
  uint32: [0n, 4294967295n],
  int64: [-9223372036854775808n, 9223372036854775807n],
  uint64: [0n, 18446744073709551615n],
};
const FLOAT32_MAX = 3.4028234663852886e38;
const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const OPCUA_WRITE_TYPE_MATRIX: Record<string, TypeRule> = {};

function register(names: string[], rule: TypeRule): void {
  for (const name of names) OPCUA_WRITE_TYPE_MATRIX[name] = rule;
}

register(['boolean', 'bool'], { canonical: 'Boolean' });
for (const [name, [min, max]] of Object.entries(INT_RANGES)) {
  register([name], { canonical: 'Integer', min, max });
}
register(['integer', 'int', 'enumeration'], {
  canonical: 'Integer',
  min: INT_RANGES.int32[0],
  max: INT_RANGES.int32[1],
});
register(['float', 'single', 'double'], { canonical: 'Float' });
register(['string'], { canonical: 'String' });
register(['datetime'], { canonical: 'DateTime' });
register(['date'], { canonical: 'Date' });
register(['time'], { canonical: 'Time' });
register(['duration', 'timespan'], { canonical: 'Duration' });

function reject(reason: WriteCoercionReason): WriteCoercionResult {
  return { ok: false, reason };
}

function integerValue(value: unknown, rule: TypeRule): WriteCoercionResult {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return reject('lossy_conversion');
    if (!Number.isSafeInteger(value)) return reject('lossy_conversion');
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const integerText = value.trim();
    if (integerText.replace(/^[+-]/, '').length > 21) return reject('integer_out_of_range');
    parsed = BigInt(integerText);
  } else return reject('invalid_integer');
  if (
    (rule.min !== undefined && parsed < rule.min) ||
    (rule.max !== undefined && parsed > rule.max)
  ) {
    return reject('integer_out_of_range');
  }
  const asNumber = Number(parsed);
  return { ok: true, value: Number.isSafeInteger(asNumber) ? asNumber : parsed.toString() };
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function validTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/.exec(value);
  if (!match) return false;
  const [, hour, minute, second = '0'] = match;
  return Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
}

function scalar(value: unknown, rule: TypeRule, rawType: string): WriteCoercionResult {
  if (value === null || value === undefined) return reject('null_not_allowed');
  if (Array.isArray(value) || typeof value === 'object') return reject('scalar_required');
  if (rule.canonical === 'Boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'number' && (value === 0 || value === 1))
      return { ok: true, value: value === 1 };
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'on', 'yes'].includes(normalized)) return { ok: true, value: true };
      if (['false', '0', 'off', 'no'].includes(normalized)) return { ok: true, value: false };
    }
    return reject('invalid_boolean');
  }
  if (rule.canonical === 'Integer') return integerValue(value, rule);
  if (rule.canonical === 'Float' || rule.canonical === 'Duration') {
    if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string')) {
      return reject('invalid_float');
    }
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed === '' || (typeof trimmed === 'string' && !DECIMAL_NUMBER_RE.test(trimmed))) {
      return reject('invalid_float');
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      if (rawType === 'float' || rawType === 'single') {
        if (Math.abs(parsed) > FLOAT32_MAX) return reject('float_out_of_range');
        if (!Object.is(Math.fround(parsed), parsed)) return reject('lossy_conversion');
      }
      return { ok: true, value: parsed };
    }
    return reject('non_finite_float');
  }
  if (rule.canonical === 'String') {
    if (typeof value === 'string') return { ok: true, value };
    if (rawType === 'string' && typeof value === 'boolean') {
      return { ok: true, value: value ? 'True' : 'False' };
    }
    if (rawType === 'string' && typeof value === 'number' && Number.isFinite(value)) {
      return { ok: true, value: String(value) };
    }
    return reject('invalid_string');
  }
  if (typeof value !== 'string') return reject('invalid_temporal');
  const trimmed = value.trim();
  if (rule.canonical === 'Date')
    return validDate(trimmed) ? { ok: true, value: trimmed } : reject('invalid_temporal');
  if (rule.canonical === 'Time')
    return validTime(trimmed) ? { ok: true, value: trimmed } : reject('invalid_temporal');
  const dateTime =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(
      trimmed,
    );
  if (
    !dateTime ||
    !validDate(dateTime[1]) ||
    !validTime(dateTime[2]) ||
    (dateTime[4] !== undefined && (Number(dateTime[4]) > 23 || Number(dateTime[5]) > 59))
  ) {
    return reject('invalid_temporal');
  }
  return { ok: true, value: trimmed };
}

function rangeBounds(
  descriptor: OpcuaWriteDescriptor,
): readonly [number | undefined, number | undefined] | null {
  const { min, max } = descriptor;
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) return null;
  return [min, max];
}

function inRange(
  value: unknown,
  [min, max]: readonly [number | undefined, number | undefined],
): boolean {
  if (typeof value !== 'number') return true;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

export function coerceOpcuaWrite(
  value: unknown,
  descriptor: OpcuaWriteDescriptor,
): WriteCoercionResult {
  const rawType = (descriptor.dataType ?? '').trim().toLowerCase();
  const rule = OPCUA_WRITE_TYPE_MATRIX[rawType];
  if (!rule) return reject('unknown_type');
  if (descriptor.isArray !== undefined && typeof descriptor.isArray !== 'boolean') {
    return reject('invalid_descriptor');
  }
  if (
    descriptor.arrayLength !== undefined &&
    descriptor.arrayLength !== null &&
    (!descriptor.isArray || !Number.isInteger(descriptor.arrayLength))
  ) {
    return reject('invalid_descriptor');
  }
  let result: WriteCoercionResult;
  if (descriptor.indexed) {
    if (!descriptor.isArray) return reject('invalid_descriptor');
    if (
      descriptor.arrayIndex !== undefined &&
      (!Number.isInteger(descriptor.arrayIndex) ||
        descriptor.arrayIndex < 0 ||
        descriptor.arrayIndex > 10000 ||
        (descriptor.arrayLength !== undefined &&
          descriptor.arrayLength !== null &&
          descriptor.arrayLength > 0 &&
          descriptor.arrayIndex >= descriptor.arrayLength))
    ) {
      return reject('array_index_out_of_bounds');
    }
    result =
      Array.isArray(value) || (value !== null && typeof value === 'object')
        ? reject('scalar_required')
        : scalar(value, rule, rawType);
  } else if (descriptor.isArray) {
    if (!Array.isArray(value)) return reject('array_required');
    if (
      descriptor.arrayLength !== undefined &&
      descriptor.arrayLength !== null &&
      descriptor.arrayLength > 0 &&
      value.length !== descriptor.arrayLength
    ) {
      return reject('array_length_mismatch');
    }
    const output: unknown[] = [];
    for (const item of value) {
      const itemResult = scalar(item, rule, rawType);
      if (!itemResult.ok) return itemResult;
      output.push(itemResult.value);
    }
    result = { ok: true, value: output };
  } else {
    result = scalar(value, rule, rawType);
  }
  if (!result.ok) return result;
  const bounds = rangeBounds(descriptor);
  if (bounds) {
    const values = Array.isArray(result.value) ? result.value : [result.value];
    if (!values.every((item) => inRange(item, bounds))) return reject('value_out_of_range');
  }
  return result;
}

export function canonicalOpcuaWriteType(
  dataType: string | undefined,
): TypeRule['canonical'] | null {
  return OPCUA_WRITE_TYPE_MATRIX[(dataType ?? '').trim().toLowerCase()]?.canonical ?? null;
}
