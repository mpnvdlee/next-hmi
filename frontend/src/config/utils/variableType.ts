import { subscribeConfigChanged } from '@shared/events/configChangedBus';
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

// Every bound field on a panel asks for its variable's type, and each answer is
// in the same full tree, so one download per datasource serves them all.
const variableTrees = new Map<string, Promise<unknown[]>>();

/** Forget the downloaded trees, after a datasource or its variables changed. */
export function forgetVariableTrees(): void {
  variableTrees.clear();
}

subscribeConfigChanged((event) => {
  if (event.artifact_type === 'datasource' || event.artifact_type === 'variables') {
    forgetVariableTrees();
  }
});

function loadVariableTree(datasource: string): Promise<unknown[]> {
  let tree = variableTrees.get(datasource);
  if (!tree) {
    tree = apiJson<{ variables?: unknown[] }>(
      `/api/datasources/${encodeURIComponent(datasource)}/variables?simple=false`,
    ).then((payload) => (Array.isArray(payload.variables) ? payload.variables : []));
    // A failed download is not remembered: the next field asks again.
    tree.catch(() => variableTrees.delete(datasource));
    variableTrees.set(datasource, tree);
  }
  return tree;
}

export async function loadVariableWriteDescriptor(
  datasource: string,
  path: string,
): Promise<VariableWriteDescriptor | undefined> {
  try {
    const variables = await loadVariableTree(datasource);
    // `[…]` is a bound index: one element, which one only known at run time.
    const indexMatch = /\[(-?\d+|…)\]$/.exec(path);
    const descriptor = findVariableWriteDescriptor(variables, path.slice(0, indexMatch?.index));
    return descriptor
      ? {
          ...descriptor,
          complete: true,
          ...(indexMatch && {
            indexed: true,
            ...(indexMatch[1] !== '…' && { arrayIndex: Number(indexMatch[1]) }),
          }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}
