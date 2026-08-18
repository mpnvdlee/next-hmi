import type { StructSchemaNode } from '@shared/types/componentProperty';
import {
  appendNode,
  flattenTree,
  getNodeAt,
  parsePath,
  patchNode,
  removeNode,
  uniqueName,
} from './structTreeMutations';

const TREE: StructSchemaNode[] = [
  { kind: 'variable', name: 'bReady', type: 'Boolean' },
  {
    kind: 'folder',
    name: 'Limits',
    children: [
      { kind: 'variable', name: 'fMin', type: 'Float' },
      {
        kind: 'folder',
        name: 'Nested',
        children: [{ kind: 'variable', name: 'fDeep', type: 'Float' }],
      },
    ],
  },
];

describe('parsePath', () => {
  it('splits a slash path into numeric indices', () => {
    expect(parsePath('0')).toEqual([0]);
    expect(parsePath('1/1/0')).toEqual([1, 1, 0]);
  });
});

describe('getNodeAt', () => {
  it('returns a top-level node', () => {
    expect(getNodeAt(TREE, [0])).toEqual(TREE[0]);
  });

  it('walks into a nested folder', () => {
    expect(getNodeAt(TREE, [1, 0])).toEqual({ kind: 'variable', name: 'fMin', type: 'Float' });
  });

  it('walks two levels deep', () => {
    expect(getNodeAt(TREE, [1, 1, 0])).toEqual({
      kind: 'variable',
      name: 'fDeep',
      type: 'Float',
    });
  });

  it('returns null for an out-of-range index', () => {
    expect(getNodeAt(TREE, [5])).toBeNull();
  });

  it('returns null when descending past a non-folder leaf', () => {
    expect(getNodeAt(TREE, [0, 0])).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(getNodeAt(TREE, [])).toBeNull();
  });
});

describe('appendNode', () => {
  it('appends to the root when folderPath is null', () => {
    const newNode: StructSchemaNode = { kind: 'variable', name: 'bNew', type: 'Boolean' };
    const result = appendNode(TREE, null, newNode);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual(newNode);
    expect(TREE).toHaveLength(2); // original untouched
  });

  it('appends into a top-level folder immutably', () => {
    const newNode: StructSchemaNode = { kind: 'variable', name: 'fMax', type: 'Float' };
    const result = appendNode(TREE, '1', newNode);
    const limits = result[1];
    expect(limits.children).toHaveLength(3);
    expect(limits.children?.[2]).toEqual(newNode);
    // Sibling top-level node and the original tree are untouched.
    expect(result[0]).toBe(TREE[0]);
    expect(TREE[1].children).toHaveLength(2);
  });

  it('appends into a doubly-nested folder, preserving sibling branches', () => {
    const newNode: StructSchemaNode = { kind: 'variable', name: 'fDeep2', type: 'Float' };
    const result = appendNode(TREE, '1/1', newNode);
    const nested = result[1].children?.[1];
    expect(nested?.children).toHaveLength(2);
    expect(nested?.children?.[1]).toEqual(newNode);
    // The 'fMin' sibling at the same level as 'Nested' is untouched by identity.
    expect(result[1].children?.[0]).toBe(TREE[1].children?.[0]);
  });
});

describe('removeNode', () => {
  it('removes a top-level node immutably', () => {
    const result = removeNode(TREE, '0');
    expect(result).toEqual([TREE[1]]);
    expect(TREE).toHaveLength(2);
  });

  it('removes a nested node while preserving its folder and siblings', () => {
    const result = removeNode(TREE, '1/1');
    expect(result[1].children).toEqual([{ kind: 'variable', name: 'fMin', type: 'Float' }]);
    expect(TREE[1].children).toHaveLength(2); // original untouched
  });

  it('removes a doubly-nested node', () => {
    const result = removeNode(TREE, '1/1/0');
    expect(result[1].children?.[1].children).toEqual([]);
  });
});

describe('patchNode', () => {
  it('patches a top-level node immutably', () => {
    const result = patchNode(TREE, '0', { name: 'bReadyRenamed' });
    expect(result[0]).toEqual({ kind: 'variable', name: 'bReadyRenamed', type: 'Boolean' });
    expect(TREE[0].name).toBe('bReady');
  });

  it('patches a nested node without disturbing its folder siblings', () => {
    const result = patchNode(TREE, '1/0', { write: true });
    expect(result[1].children?.[0]).toEqual({
      kind: 'variable',
      name: 'fMin',
      type: 'Float',
      write: true,
    });
    // The nested folder sibling is untouched by identity.
    expect(result[1].children?.[1]).toBe(TREE[1].children?.[1]);
  });

  it('patches a doubly-nested node', () => {
    const result = patchNode(TREE, '1/1/0', { type: 'Double' });
    expect(result[1].children?.[1].children?.[0]).toEqual({
      kind: 'variable',
      name: 'fDeep',
      type: 'Double',
    });
  });
});

describe('uniqueName', () => {
  it('returns the base name when unused', () => {
    expect(uniqueName('Field', new Set())).toBe('Field');
  });

  it('suffixes _1 when the base is taken', () => {
    expect(uniqueName('Field', new Set(['Field']))).toBe('Field_1');
  });

  it('increments past every taken suffix', () => {
    expect(uniqueName('Field', new Set(['Field', 'Field_1', 'Field_2']))).toBe('Field_3');
  });
});

describe('flattenTree', () => {
  it('flattens every visible node with depth and path when nothing is collapsed', () => {
    const rows = flattenTree(TREE, new Set());
    expect(rows.map((r) => [r.path, r.depth, r.node.name])).toEqual([
      ['0', 0, 'bReady'],
      ['1', 0, 'Limits'],
      ['1/0', 1, 'fMin'],
      ['1/1', 1, 'Nested'],
      ['1/1/0', 2, 'fDeep'],
    ]);
  });

  it('omits children of a collapsed folder but keeps the folder row itself', () => {
    const rows = flattenTree(TREE, new Set(['1']));
    expect(rows.map((r) => r.path)).toEqual(['0', '1']);
  });

  it('collapsing a nested folder only hides its own children', () => {
    const rows = flattenTree(TREE, new Set(['1/1']));
    expect(rows.map((r) => r.path)).toEqual(['0', '1', '1/0', '1/1']);
  });

  it("records each row's parentFolderPath", () => {
    const rows = flattenTree(TREE, new Set());
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.parentFolderPath]));
    expect(byPath['0']).toBeNull();
    expect(byPath['1/0']).toBe('1');
    expect(byPath['1/1/0']).toBe('1/1');
  });
});
