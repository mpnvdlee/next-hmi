import { apiJson } from '@shared/utils/api';
import { canonicalOpcuaWriteType } from '@shared/utils/opcuaWriteCoercion';

type WriteCoercionKind = 'boolean' | 'number' | 'string' | null;
export interface VariableWriteDescriptor {
  dataType: string;
  isArray: boolean;
  arrayLength?: number;
  indexed?: boolean;
  arrayIndex?: number;
  complete?: boolean;
  min?: number;
  max?: number;
}

export function writeDescriptorNeedsRefresh(
  descriptor: VariableWriteDescriptor | undefined,
): boolean {
  return descriptor?.complete !== true;
}

export function getWriteCoercionKind(dataType: string | undefined): WriteCoercionKind {
  switch (canonicalOpcuaWriteType(dataType)) {
    case 'String':
    case 'DateTime':
    case 'Date':
    case 'Time':
      return 'string';
    case 'Boolean':
      return 'boolean';
    case 'Integer':
    case 'Float':
    case 'Duration':
      return 'number';
    default:
      return null;
  }
}

function findVariableWriteDescriptor(
  nodes: unknown[],
  targetPath: string,
  prefix = '',
): VariableWriteDescriptor | undefined {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (record.kind === 'folder') {
      const name = String(record.name ?? '');
      const folderPath = prefix ? `${prefix}/${name}` : name;
      const childType = findVariableWriteDescriptor(
        Array.isArray(record.children) ? record.children : [],
        targetPath,
        folderPath,
      );
      if (childType) return childType;
      continue;
    }

    const displayName = String(record.display_name ?? '');
    const path = prefix ? `${prefix}/${displayName}` : displayName;
    if (path === targetPath) {
      if (typeof record.data_type !== 'string') return undefined;
      return {
        dataType: record.data_type,
        isArray: record.is_array === true,
        ...(typeof record.array_length === 'number' && { arrayLength: record.array_length }),
        ...(typeof record.min === 'number' && { min: record.min }),
        ...(typeof record.max === 'number' && { max: record.max }),
      };
    }
  }
  return undefined;
}

export async function loadVariableWriteDescriptor(
  datasource: string,
  path: string,
): Promise<VariableWriteDescriptor | undefined> {
  try {
    const payload = await apiJson<{ variables?: unknown[] }>(
      `/api/datasources/${encodeURIComponent(datasource)}/variables?simple=false`,
    );
    const indexMatch = /\[(-?\d+)\]$/.exec(path);
    const descriptor = findVariableWriteDescriptor(
      Array.isArray(payload.variables) ? payload.variables : [],
      path.replace(/\[-?\d+\]$/, ''),
    );
    return descriptor
      ? {
          ...descriptor,
          complete: true,
          ...(indexMatch && { indexed: true, arrayIndex: Number(indexMatch[1]) }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}
