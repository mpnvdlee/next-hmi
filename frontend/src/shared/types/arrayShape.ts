// ── Array-shape helpers ──────────────────────────────────────────────────────
// `is_array` + optional `array_length` is the canonical array encoding for
// variable/struct/folder tree nodes: is_array=true + no array_length (or a
// non-positive one) means dynamic/unknown length; is_array=true + a positive
// array_length means fixed size; is_array absent/false means scalar.

interface ArrayShapeNode {
  is_array?: boolean;
  array_length?: number;
}

export function isArrayShape(node: ArrayShapeNode): boolean {
  return !!node.is_array;
}

export function isFixedArray(node: ArrayShapeNode): boolean {
  return isArrayShape(node) && typeof node.array_length === 'number' && node.array_length > 0;
}

function isDynamicArray(node: ArrayShapeNode): boolean {
  return isArrayShape(node) && !isFixedArray(node);
}

/** `[N]` for a fixed array, `[]` for a dynamic array, `''` for a scalar. */
export function arrayBadgeSuffix(node: ArrayShapeNode): string {
  if (isFixedArray(node)) return `[${node.array_length}]`;
  if (isDynamicArray(node)) return '[]';
  return '';
}
