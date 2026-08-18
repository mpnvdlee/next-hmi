import { describe, expect, it, vi } from 'vitest';
import {
  getWriteCoercionKind,
  loadVariableWriteDescriptor,
  writeDescriptorNeedsRefresh,
} from './variableType';

vi.mock('@shared/utils/api', () => ({
  apiJson: vi.fn(async () => ({
    variables: [
      {
        kind: 'variable',
        display_name: 'Count',
        data_type: 'UInt16',
        is_array: true,
        array_length: 2,
      },
    ],
  })),
}));

describe('write value classification', () => {
  it('classifies canonical and persisted raw OPC-UA names', () => {
    expect(getWriteCoercionKind('Boolean')).toBe('boolean');
    expect(getWriteCoercionKind('UInt64')).toBe('number');
    expect(getWriteCoercionKind('Double')).toBe('number');
    expect(getWriteCoercionKind('DateTime')).toBe('string');
    expect(getWriteCoercionKind('LocalizedText')).toBeNull();
  });

  it('loads the persisted raw type instead of the simplified type', async () => {
    const { apiJson } = await import('@shared/utils/api');
    expect(await loadVariableWriteDescriptor('PLC', 'Count[1]')).toEqual({
      dataType: 'UInt16',
      isArray: true,
      arrayLength: 2,
      indexed: true,
      arrayIndex: 1,
      complete: true,
    });
    expect(apiJson).toHaveBeenCalledWith('/api/datasources/PLC/variables?simple=false');
  });

  it('carries numeric min/max onto the descriptor when configured', async () => {
    const { apiJson } = await import('@shared/utils/api');
    vi.mocked(apiJson).mockResolvedValueOnce({
      variables: [
        { kind: 'variable', display_name: 'Temp', data_type: 'Float', min: -20, max: 10 },
      ],
    });
    expect(await loadVariableWriteDescriptor('PLC', 'Temp')).toEqual({
      dataType: 'Float',
      isArray: false,
      min: -20,
      max: 10,
      complete: true,
    });
  });

  it('omits min/max when not configured', async () => {
    const { apiJson } = await import('@shared/utils/api');
    vi.mocked(apiJson).mockResolvedValueOnce({
      variables: [{ kind: 'variable', display_name: 'Temp', data_type: 'Float' }],
    });
    const descriptor = await loadVariableWriteDescriptor('PLC', 'Temp');
    expect(descriptor).not.toHaveProperty('min');
    expect(descriptor).not.toHaveProperty('max');
  });

  it('refreshes partial picker metadata but keeps a complete raw descriptor', () => {
    expect(writeDescriptorNeedsRefresh(undefined)).toBe(true);
    expect(writeDescriptorNeedsRefresh({ dataType: 'UInt16', isArray: true, arrayLength: 2 })).toBe(
      true,
    );
    expect(
      writeDescriptorNeedsRefresh({
        dataType: 'UInt16',
        isArray: true,
        arrayLength: 2,
        complete: true,
      }),
    ).toBe(false);
  });
});
