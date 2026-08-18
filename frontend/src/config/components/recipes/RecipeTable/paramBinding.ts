import type { RecipeDataType, RecipeParameter } from '@shared/types/recipe';
import { toSimpleType } from '@shared/utils/valueTypes';
import type { BindingPickMetadata } from '@config/store/domains/editorDomainStore';
import type { VariableBinding } from '@shared/types/config';

/** Simple type (from valueTypes.toSimpleType) → recipe scalar data type. */
function recipeScalarType(simple: string): RecipeDataType {
  switch (simple) {
    case 'Boolean':
      return 'boolean';
    case 'Integer':
      return 'integer';
    case 'String':
      return 'string';
    case 'DateTime':
    case 'Date':
    case 'Time':
      return 'datetime';
    default:
      return 'float';
  }
}

/** Derive a parameter data type from a picked variable's metadata + binding. */
export function inferDataType(
  binding: VariableBinding,
  meta?: BindingPickMetadata,
): RecipeDataType {
  const scalar = recipeScalarType(toSimpleType(meta?.dataType));
  const isArray = binding.index === undefined && !!meta?.isArray;
  return isArray ? (`${scalar}[]` as RecipeDataType) : scalar;
}

/** Human-readable variable location from a $var binding. */
export function bindingPath(binding: unknown): string {
  const v = (binding as { $var?: { path?: string; index?: number } } | undefined)?.$var;
  if (!v?.path) return '';
  return v.index === undefined ? v.path : `${v.path}[${v.index}]`;
}

/** Default parameter label from a binding path (last location segment). */
export function labelFromPath(path: string): string {
  const loc = path.includes(':') ? path.slice(path.indexOf(':') + 1) : path;
  return loc.split('/').pop() || loc;
}

/** Parameter rows the search box keeps — matched on label, bound path or type. */
export function filterParameters(params: RecipeParameter[], filter: string): RecipeParameter[] {
  const q = filter.trim().toLowerCase();
  if (!q) return params;
  return params.filter((p) =>
    [p.label, bindingPath(p.binding), p.dataType].some((field) => field.toLowerCase().includes(q)),
  );
}
