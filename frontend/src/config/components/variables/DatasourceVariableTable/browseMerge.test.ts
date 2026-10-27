import { describe, expect, it } from 'vitest';
import type { BrowseNode } from '@config/components/ui/datasourceTreeHelpers';
import type { FolderEntry, TreeNode, VariableEntry } from '@shared/types/datasource';
import { isFolder } from '@shared/types/datasource';
import {
  applyPlcCheck,
  browseTopLevel,
  mergeBrowseSelection,
  newLeafIds,
  pickBrowseSelection,
  savedNodeIds,
  staleRows,
  withBrowseChildren,
} from './browseMerge';
import { normalizeArrayStructIndices } from './mutationHelpers';

function leaf(nodeId: string, dataType = 'Double'): BrowseNode {
  const name = nodeId.slice(Math.max(nodeId.lastIndexOf('.'), nodeId.lastIndexOf(']')) + 1);
  return { node_id: nodeId, display_name: name, data_type: dataType, writable: true, children: [] };
}

function folder(nodeId: string, name: string, children: BrowseNode[]): BrowseNode {
  return { node_id: nodeId, display_name: name, data_type: null, children };
}

function struct(nodeId: string, name: string, children: BrowseNode[], isArray = false): BrowseNode {
  return {
    node_id: nodeId,
    display_name: name,
    data_type: 'struct',
    children,
    ...(isArray && { is_array: true }),
  };
}

// The FakePlc demo program, as a marked/all browse returns it.
const BROWSE: BrowseNode[] = [
  folder('MAIN', 'MAIN', [
    leaf('MAIN.fSpeed'),
    struct('MAIN.stMotor', 'stMotor', [
      leaf('MAIN.stMotor.fSpeed'),
      leaf('MAIN.stMotor.bRunning', 'Boolean'),
      struct('MAIN.stMotor.stLimits', 'stLimits', [
        leaf('MAIN.stMotor.stLimits.fMin'),
        leaf('MAIN.stMotor.stLimits.fMax'),
      ]),
    ]),
    struct(
      'MAIN.aPoints',
      'aPoints',
      [1, 2, 3].map((i) =>
        struct(`MAIN.aPoints[${i}]`, `[${i}]`, [
          leaf(`MAIN.aPoints[${i}].x`, 'Float'),
          leaf(`MAIN.aPoints[${i}].y`, 'Float'),
        ]),
      ),
      true,
    ),
  ]),
  folder('GVL', 'GVL', [leaf('GVL.sVersion', 'String')]),
];

const SAVED: TreeNode[] = [
  {
    kind: 'folder',
    name: 'MAIN',
    node_id: 'MAIN',
    children: [
      {
        kind: 'variable',
        node_id: 'MAIN.fSpeed',
        display_name: 'fSpeed',
        data_type: 'Double',
        enabled: true,
        writable: true,
        min: 0,
        max: 100,
      },
    ],
  },
];

function find(tree: TreeNode[], path: string): TreeNode | undefined {
  const [head, ...rest] = path.split('/');
  const node = tree.find((n) => (isFolder(n) ? n.name : n.display_name) === head);
  if (!node || rest.length === 0) return node;
  return isFolder(node) ? find(node.children, rest.join('/')) : undefined;
}

describe('mergeBrowseSelection', () => {
  it('adds ticked variables into the existing tree under their PLC path, disabled', () => {
    const next = mergeBrowseSelection(
      SAVED,
      BROWSE,
      new Set(['MAIN.stMotor.bRunning', 'GVL.sVersion']),
    );

    const main = find(next, 'MAIN') as FolderEntry;
    expect(main.children.map((n) => (isFolder(n) ? n.name : n.display_name))).toEqual([
      'fSpeed',
      'stMotor',
    ]);
    expect(find(next, 'MAIN/stMotor')).toMatchObject({ kind: 'folder', node_id: 'MAIN.stMotor' });
    expect(find(next, 'MAIN/stMotor/bRunning')).toEqual({
      kind: 'variable',
      node_id: 'MAIN.stMotor.bRunning',
      display_name: 'bRunning',
      data_type: 'Boolean',
      enabled: false,
      writable: true,
    });
    expect(find(next, 'GVL/sVersion')).toMatchObject({ node_id: 'GVL.sVersion', enabled: false });
  });

  it('creates nested struct folders as needed', () => {
    const next = mergeBrowseSelection([], BROWSE, new Set(['MAIN.stMotor.stLimits.fMax']));
    expect(next).toEqual([
      {
        kind: 'folder',
        name: 'MAIN',
        node_id: 'MAIN',
        children: [
          {
            kind: 'folder',
            name: 'stMotor',
            node_id: 'MAIN.stMotor',
            children: [
              {
                kind: 'folder',
                name: 'stLimits',
                node_id: 'MAIN.stMotor.stLimits',
                children: [
                  {
                    kind: 'variable',
                    node_id: 'MAIN.stMotor.stLimits.fMax',
                    display_name: 'fMax',
                    data_type: 'Double',
                    enabled: false,
                    writable: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('matches saved variables by node id and never modifies or duplicates them', () => {
    // Saved somewhere else, under another name: still the same PLC variable.
    const saved: TreeNode[] = [
      ...SAVED,
      {
        kind: 'variable',
        node_id: 'GVL.sVersion',
        display_name: 'Version',
        data_type: 'String',
        enabled: true,
        present_on_server: false,
      },
    ];
    const next = mergeBrowseSelection(saved, BROWSE, new Set(['MAIN.fSpeed', 'GVL.sVersion']));
    expect(next).toEqual(saved);
    expect(next).not.toBe(saved);
  });

  it('never removes a saved variable the browse does not show', () => {
    const saved: TreeNode[] = [
      ...SAVED,
      {
        kind: 'variable',
        node_id: 'MAIN.bOld',
        display_name: 'bOld',
        data_type: 'Boolean',
        enabled: true,
      },
    ];
    const next = mergeBrowseSelection(
      saved,
      [folder('GVL', 'GVL', [leaf('GVL.sVersion')])],
      new Set(['GVL.sVersion']),
    );
    expect(find(next, 'bOld')).toEqual(saved[1]);
    expect(find(next, 'MAIN/fSpeed')).toEqual((SAVED[0] as FolderEntry).children[0]);
  });

  it('adds a struct-array member ticked in one element to every element', () => {
    const next = mergeBrowseSelection([], BROWSE, new Set(['MAIN.aPoints[2].y']));
    const points = find(next, 'MAIN/aPoints') as FolderEntry;
    expect(points).toMatchObject({ kind: 'folder', node_id: 'MAIN.aPoints', is_array: true });
    expect(points.children).toEqual(
      [1, 2, 3].map((i) => ({
        kind: 'folder',
        name: `[${i}]`,
        node_id: `MAIN.aPoints[${i}]`,
        children: [
          {
            kind: 'variable',
            node_id: `MAIN.aPoints[${i}].y`,
            display_name: 'y',
            data_type: 'Float',
            enabled: false,
            writable: true,
          },
        ],
      })),
    );
  });

  it('adds to a saved struct array whose elements the tree renamed, matching them by node id', () => {
    // What the table stores after normalizeArrayStructIndices: [1] → aPoints[0].
    const saved = normalizeArrayStructIndices(
      mergeBrowseSelection([], BROWSE, new Set(['MAIN.aPoints[1].x'])),
    );
    expect(
      (find(saved, 'MAIN/aPoints') as FolderEntry).children.map((c) => (c as FolderEntry).name),
    ).toEqual(['aPoints[0]', 'aPoints[1]', 'aPoints[2]']);

    const next = normalizeArrayStructIndices(
      mergeBrowseSelection(saved, BROWSE, new Set(['MAIN.aPoints[3].y'])),
    );
    const elements = (find(next, 'MAIN/aPoints') as FolderEntry).children as FolderEntry[];
    expect(elements).toHaveLength(3);
    for (const [i, element] of elements.entries()) {
      expect(element.node_id).toBe(`MAIN.aPoints[${i + 1}]`);
      expect(element.children.map((c) => (c as VariableEntry).node_id)).toEqual([
        `MAIN.aPoints[${i + 1}].x`,
        `MAIN.aPoints[${i + 1}].y`,
      ]);
    }
  });

  it('builds struct-array elements a lazy browse never expanded from the ticked one', () => {
    const lazy: BrowseNode[] = [
      struct(
        'MAIN.aPoints',
        'aPoints',
        [
          struct('MAIN.aPoints[1]', '[1]', [leaf('MAIN.aPoints[1].x', 'Float')]),
          { ...struct('MAIN.aPoints[2]', '[2]', []), has_children: true },
        ],
        true,
      ),
    ];
    const picked = pickBrowseSelection(lazy, new Set(['MAIN.aPoints[1].x']));
    expect(picked[0].children?.map((e) => e.children?.map((m) => m.node_id))).toEqual([
      ['MAIN.aPoints[1].x'],
      ['MAIN.aPoints[2].x'],
    ]);
  });

  it('adds nothing for an empty selection', () => {
    expect(mergeBrowseSelection(SAVED, BROWSE, new Set())).toEqual(SAVED);
  });
});

describe('browse helpers', () => {
  it('splits a browse root into one folder per PLC path segment', () => {
    const top = browseTopLevel({
      node_id: 'MAIN.stMotor',
      display_name: 'MAIN.stMotor',
      data_type: null,
      show_root: true,
      children: [leaf('MAIN.stMotor.fSpeed')],
    });
    expect(top).toEqual([
      folder('MAIN', 'MAIN', [folder('MAIN.stMotor', 'stMotor', [leaf('MAIN.stMotor.fSpeed')])]),
    ]);
    expect(browseTopLevel({ ...folder('', 'Plc', BROWSE), show_root: false })).toBe(BROWSE);
  });

  it('puts a lazily loaded level under its node', () => {
    const top = [{ ...folder('MAIN', 'MAIN', []), has_children: true }];
    const next = withBrowseChildren(top, 'MAIN', [leaf('MAIN.fSpeed')]);
    expect(next[0].children).toEqual([leaf('MAIN.fSpeed')]);
  });

  it('lists the loaded leaves that are not saved yet', () => {
    expect(newLeafIds(BROWSE, new Set(['main.fspeed', 'main.apoints[1].x']))).toEqual([
      'MAIN.stMotor.fSpeed',
      'MAIN.stMotor.bRunning',
      'MAIN.stMotor.stLimits.fMin',
      'MAIN.stMotor.stLimits.fMax',
      'MAIN.aPoints[1].y',
      'MAIN.aPoints[2].x',
      'MAIN.aPoints[2].y',
      'MAIN.aPoints[3].x',
      'MAIN.aPoints[3].y',
      'GVL.sVersion',
    ]);
  });
});

describe('applyPlcCheck', () => {
  const tree: TreeNode[] = [
    {
      kind: 'folder',
      name: 'MAIN',
      node_id: 'MAIN',
      children: [
        {
          kind: 'variable',
          node_id: 'MAIN.a',
          display_name: 'a',
          data_type: 'Double',
          enabled: true,
        },
        {
          kind: 'variable',
          node_id: 'MAIN.b',
          display_name: 'b',
          data_type: 'Double',
          enabled: true,
          present_on_server: false,
        },
        {
          kind: 'variable',
          node_id: 'MAIN.c',
          display_name: 'c',
          data_type: 'Double',
          enabled: false,
        },
      ],
    },
  ];

  it('marks missing variables stale and clears the mark on ones the PLC has again', () => {
    const next = applyPlcCheck(tree, new Set(['MAIN.c']));
    const [a, b, c] = (next[0] as FolderEntry).children as VariableEntry[];
    expect(a).toBe((tree[0] as FolderEntry).children[0]);
    expect(b).toEqual({
      kind: 'variable',
      node_id: 'MAIN.b',
      display_name: 'b',
      data_type: 'Double',
      enabled: true,
    });
    expect(c.present_on_server).toBe(false);
    expect(staleRows(next)).toEqual([
      { kind: 'removed', node_id: 'MAIN.c', path: 'MAIN/c', entry: c },
    ]);
  });

  it('removes nothing and returns the same tree when nothing changed', () => {
    expect(applyPlcCheck(tree, new Set(['MAIN.b']))).toBe(tree);
  });
});

describe('merging into what the table stores', () => {
  const v = (id: string, name: string): VariableEntry => ({
    kind: 'variable',
    node_id: id,
    display_name: name,
    data_type: 'Float',
    enabled: false,
  });
  const browseElement = (i: number): BrowseNode =>
    struct(`MAIN.aPoints[${i}]`, `[${i}]`, [
      leaf(`MAIN.aPoints[${i}].x`, 'Float'),
      leaf(`MAIN.aPoints[${i}].y`, 'Float'),
    ]);

  function memberIds(tree: TreeNode[]): string[][] {
    const points = find(tree, 'MAIN/aPoints') as FolderEntry;
    return points.children.map((e) =>
      (e as FolderEntry).children.map((m) => (m as VariableEntry).node_id ?? ''),
    );
  }

  it('gives every element of a grown struct array its own node ids', () => {
    // Saved with 3 elements and x; the PLC array now has 5, and y is ticked.
    const saved = normalizeArrayStructIndices(
      mergeBrowseSelection(
        [],
        [
          folder('MAIN', 'MAIN', [
            struct('MAIN.aPoints', 'aPoints', [1, 2, 3].map(browseElement), true),
          ]),
        ],
        new Set(['MAIN.aPoints[1].x']),
      ),
    );
    const browse = [
      folder('MAIN', 'MAIN', [
        struct('MAIN.aPoints', 'aPoints', [1, 2, 3, 4, 5].map(browseElement), true),
      ]),
    ];
    const next = normalizeArrayStructIndices(
      mergeBrowseSelection(saved, browse, new Set(['MAIN.aPoints[1].y'])),
    );
    expect(memberIds(next)).toEqual(
      [1, 2, 3, 4, 5].map((i) => [`MAIN.aPoints[${i}].x`, `MAIN.aPoints[${i}].y`]),
    );
  });

  it('keeps an element its own node ids when one of its members is removed', () => {
    const tree: TreeNode[] = [
      {
        kind: 'folder',
        name: 'MAIN',
        node_id: 'MAIN',
        children: [
          {
            kind: 'folder',
            name: 'aPoints',
            node_id: 'MAIN.aPoints',
            is_array: true,
            children: [1, 2].map((i) => ({
              kind: 'folder' as const,
              name: `aPoints[${i - 1}]`,
              node_id: `MAIN.aPoints[${i}]`,
              children:
                i === 1
                  ? [v('MAIN.aPoints[1].x', 'x'), v('MAIN.aPoints[1].y', 'y')]
                  : [v('MAIN.aPoints[2].y', 'y')],
            })),
          },
        ],
      },
    ];
    // Element 2 lost x (removed as stale): the shared layout puts it back,
    // reading element 2, not element 1.
    expect(memberIds(normalizeArrayStructIndices(tree))).toEqual([
      ['MAIN.aPoints[1].x', 'MAIN.aPoints[1].y'],
      ['MAIN.aPoints[2].x', 'MAIN.aPoints[2].y'],
    ]);
  });

  it('matches ADS node ids whatever their case', () => {
    const saved: TreeNode[] = [
      {
        kind: 'folder',
        name: 'MAIN',
        node_id: 'MAIN',
        children: [
          {
            kind: 'folder',
            name: 'stLine',
            node_id: 'MAIN.stLine',
            children: [v('MAIN.stLine.bRun', 'bRun')],
          },
        ],
      },
    ];
    const browse = [
      folder('main', 'main', [
        struct('main.stline', 'stline', [leaf('main.stline.bRun'), leaf('main.stline.nCount')]),
      ]),
    ];
    expect(newLeafIds(browse, savedNodeIds(saved))).toEqual(['main.stline.nCount']);
    const next = mergeBrowseSelection(
      saved,
      browse,
      new Set(['main.stline.bRun', 'main.stline.nCount']),
    );
    expect(next).toHaveLength(1);
    expect(
      ((find(next, 'MAIN/stLine') as FolderEntry).children as VariableEntry[]).map(
        (c) => c.node_id,
      ),
    ).toEqual(['MAIN.stLine.bRun', 'main.stline.nCount']);
  });
});
