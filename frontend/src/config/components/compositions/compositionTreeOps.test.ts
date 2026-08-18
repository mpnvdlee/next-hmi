import { afterEach, describe, it, expect } from 'vitest';
import { registerComponents } from '@hmi/registry/widgetRegistry';
import { makeWidgetSlotId } from '@shared/constants/editorSentinels';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import {
  classifyCompositionClipboard,
  componentChildren,
  duplicateWidgets,
  findWidgetParent,
  flattenVisibleWidgets,
  insertWidgetAt,
  insertWidgetsAt,
  moveWidgetsToIndex,
  moveWidgetsWithin,
  removeWidgets,
  topLevelWidgetIds,
} from './compositionTreeOps';
import { resolveCompositionDrop } from './compositionDrop';
import type { DropBand } from '../editor/WidgetTree/dropTarget';

// Spies on the page editor's envelope reader while keeping its real behaviour —
// the components editor must classify batches through it rather than through a
// second copy of the marker and version.
const readMultiEnvelopeSpy = vi.hoisted(() => vi.fn());
vi.mock('../editor/WidgetTree/clipboardOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor/WidgetTree/clipboardOps')>();
  readMultiEnvelopeSpy.mockImplementation(actual.readMultiEnvelope);
  return { ...actual, readMultiEnvelope: readMultiEnvelopeSpy };
});

function widget(id: string, children?: WidgetConfig[]): WidgetConfig {
  return {
    id,
    type: children ? 'Container' : 'Button',
    name: id,
    ...(children ? { children } : {}),
  };
}

function definition(children: WidgetConfig[]): ComponentDefinition {
  return {
    id: 'Card',
    name: 'Card',
    group: null,
    componentProperties: {},
    children,
  } as ComponentDefinition;
}

const ids = (comp: ComponentDefinition) => componentChildren(comp).map((c) => c.id);

describe('findWidgetParent', () => {
  it('reports the definition root as a null parent', () => {
    const comp = definition([widget('a')]);
    expect(findWidgetParent(comp, 'a')).toMatchObject({ parentId: null, index: 0 });
  });

  it('finds a nested widget inside a container', () => {
    const comp = definition([widget('box', [widget('a'), widget('b')])]);
    expect(findWidgetParent(comp, 'b')).toMatchObject({ parentId: 'box', index: 1 });
  });
});

describe('insertWidgetAt', () => {
  it('appends into a container', () => {
    const comp = definition([widget('box', [widget('a')])]);
    const updated = insertWidgetAt(comp, 'box', 'container', widget('new'))!;
    expect(componentChildren(updated)[0].children?.map((c) => c.id)).toEqual(['a', 'new']);
  });

  it('inserts next to a leaf, not inside it', () => {
    const comp = definition([widget('box', [widget('a'), widget('b')])]);
    const updated = insertWidgetAt(comp, 'a', 'leaf', widget('new'))!;
    expect(componentChildren(updated)[0].children?.map((c) => c.id)).toEqual(['a', 'new', 'b']);
  });

  it('appends to the definition root', () => {
    const comp = definition([widget('a')]);
    expect(ids(insertWidgetAt(comp, comp.id, 'root', widget('new'))!)).toEqual(['a', 'new']);
  });
});

describe('duplicateWidgets', () => {
  it('places the clone right after the original, with fresh ids all the way down', () => {
    const comp = definition([widget('box', [widget('a')]), widget('tail')]);
    const result = duplicateWidgets(comp, ['box'])!;
    const roots = componentChildren(result.component);
    expect(roots.map((c) => c.id)).toEqual(['box', result.newIds[0], 'tail']);
    expect(result.newIds[0]).not.toBe('box');
    expect(roots[1].children?.[0].id).not.toBe('a');
  });

  it('returns null when no id resolves', () => {
    expect(duplicateWidgets(definition([widget('a')]), ['nope'])).toBeNull();
  });
});

describe('classifyCompositionClipboard', () => {
  it('tells a component definition from a widget', () => {
    expect(classifyCompositionClipboard(definition([widget('a')]))?.kind).toBe('definition');
    expect(classifyCompositionClipboard(widget('a'))?.kind).toBe('widget');
  });

  it('reads the page editor’s multi-copy envelope', () => {
    const result = classifyCompositionClipboard({
      $hmiClipboard: 1,
      nodes: [widget('a'), widget('b')],
    });

    expect(result).toEqual({ kind: 'widgets', nodes: [widget('a'), widget('b')] });
  });

  it('rejects an envelope carrying anything but widgets', () => {
    expect(
      classifyCompositionClipboard({ $hmiClipboard: 1, nodes: [widget('a'), { nope: true }] }),
    ).toBeNull();
    // A page group reads as a widget on shape alone — only the page editor's
    // classifier tells them apart, which is why the envelope is read through it.
    expect(
      classifyCompositionClipboard({
        $hmiClipboard: 1,
        nodes: [widget('a'), { id: 'g', type: 'page-group', name: 'G', children: [] }],
      }),
    ).toBeNull();
  });

  it('reads the envelope through the page editor’s reader, not a second parser', () => {
    readMultiEnvelopeSpy.mockClear();
    const envelope = { $hmiClipboard: 1, nodes: [widget('a')] };

    expect(classifyCompositionClipboard(envelope)).toEqual({
      kind: 'widgets',
      nodes: [widget('a')],
    });
    expect(readMultiEnvelopeSpy).toHaveBeenCalledWith(envelope);

    // Whatever the shared reader accepts is a batch here too, so bumping the
    // envelope version in clipboardOps cannot strand this editor.
    readMultiEnvelopeSpy.mockReturnValueOnce([{ kind: 'widget', node: widget('a') }]);
    expect(classifyCompositionClipboard({ $hmiClipboard: 2, nodes: [widget('a')] })).toEqual({
      kind: 'widgets',
      nodes: [widget('a')],
    });
  });

  it('rejects pages and junk', () => {
    expect(
      classifyCompositionClipboard({ id: 'p', type: 'page', name: 'P', sections: {} }),
    ).toBeNull();
    expect(classifyCompositionClipboard('nope')).toBeNull();
  });
});

describe('multi-widget operations', () => {
  const tree = () =>
    definition([widget('a'), widget('box', [widget('inner'), widget('deep')]), widget('b')]);

  it('flattens the visible rows, skipping collapsed subtrees', () => {
    expect(flattenVisibleWidgets(tree(), new Set()).map((r) => r.id)).toEqual([
      'a',
      'box',
      'inner',
      'deep',
      'b',
    ]);
    expect(flattenVisibleWidgets(tree(), new Set(['box'])).map((r) => r.id)).toEqual([
      'a',
      'box',
      'b',
    ]);
  });

  it('hides children the tree never renders, because the type is no container', () => {
    const leafWithChildren = { ...widget('leaf'), children: [widget('hidden')] } as WidgetConfig;
    const comp = definition([widget('a'), leafWithChildren, widget('b')]);

    expect(flattenVisibleWidgets(comp, new Set()).map((r) => r.id)).toEqual(['a', 'leaf', 'b']);
  });

  it('drops descendants of another selected widget, in tree order', () => {
    expect(topLevelWidgetIds(tree(), ['inner', 'box', 'a'])).toEqual(['a', 'box']);
    expect(topLevelWidgetIds(tree(), ['deep', 'inner'])).toEqual(['inner', 'deep']);
  });

  it('removes every listed widget in one pass', () => {
    expect(ids(removeWidgets(tree(), ['a', 'b']))).toEqual(['box']);
  });

  it('duplicates each widget after its own original, with distinct ids', () => {
    const result = duplicateWidgets(tree(), ['a', 'b'])!;

    expect(ids(result.component)).toEqual(['a', result.newIds[0], 'box', 'b', result.newIds[1]]);
    expect(new Set(result.newIds).size).toBe(2);
  });

  it('keeps document order when inserting beside a leaf', () => {
    const inserted = insertWidgetsAt(tree(), 'a', 'leaf', [widget('x'), widget('y')])!;

    expect(ids(inserted)).toEqual(['a', 'x', 'y', 'box', 'b']);
  });

  it('appends in order into a container', () => {
    const inserted = insertWidgetsAt(tree(), 'box', 'container', [widget('x'), widget('y')])!;
    const box = componentChildren(inserted).find((c) => c.id === 'box');

    expect(box?.children?.map((c) => c.id)).toEqual(['inner', 'deep', 'x', 'y']);
  });

  it('moves several widgets into a container, keeping their ids and order', () => {
    const moved = moveWidgetsWithin(tree(), ['a', 'b'], 'box', 'container')!;
    const box = componentChildren(moved).find((c) => c.id === 'box');

    expect(ids(moved)).toEqual(['box']);
    expect(box?.children?.map((c) => c.id)).toEqual(['inner', 'deep', 'a', 'b']);
  });

  it('refuses a move into the subtree of a widget being moved, changing nothing', () => {
    expect(moveWidgetsWithin(tree(), ['a', 'box'], 'inner', 'leaf')).toBeNull();
  });

  /** The whole drag path — the drop the tree resolves, applied to the definition —
   *  since the drop's index is what says where a batch lands. */
  function applyDrop(
    component: ComponentDefinition,
    movedIds: string[],
    overId: string,
    band: DropBand,
  ) {
    const drop = resolveCompositionDrop(component, movedIds[0], overId, band, movedIds);
    if (!drop) throw new Error(`no drop on ${overId}`);
    return moveWidgetsToIndex(component, movedIds, drop.parentId, drop.index)!;
  }

  it('lands a drag of several widgets contiguously at the drop point', () => {
    expect(ids(applyDrop(tree(), ['a', 'box'], 'b', 'bottom'))).toEqual(['b', 'a', 'box']);
  });

  it('lands at the dropped-on row’s own slot when that row is itself being moved', () => {
    // Dragging a+b onto the bottom edge of b — a row inside the selection — leaves
    // them where they are. An index taken before the removal would drop the pair
    // past y.
    const row = definition([widget('x'), widget('a'), widget('b'), widget('y')]);

    expect(ids(applyDrop(row, ['a', 'b'], 'b', 'bottom'))).toEqual(['x', 'a', 'b', 'y']);
  });

  it('lands above a moved row when the drop is on its top edge', () => {
    const row = definition([widget('a'), widget('c'), widget('x'), widget('b'), widget('y')]);

    expect(ids(applyDrop(row, ['a', 'c', 'b'], 'b', 'top'))).toEqual(['x', 'a', 'c', 'b', 'y']);
  });
});

describe('flattenVisibleWidgets with component slots', () => {
  const instance: WidgetConfig = {
    id: 'card-1',
    type: '$component:card',
    name: 'Card',
    children: [
      { id: 'w1', type: 'Text', name: 'In head', slot: 'header' },
      { id: 'w2', type: 'Text', name: 'In body', slot: 'body' },
    ],
  };

  function registerCard(slots: string[]) {
    registerComponents([
      {
        id: 'card',
        name: 'Card',
        componentProperties: {},
        children: slots.map((slot, i) => ({
          id: `s${i}`,
          type: 'ComponentSlot',
          name: slot,
          properties: { slot },
        })),
      } as unknown as ComponentDefinition,
    ]);
  }

  afterEach(() => registerComponents([]));

  it('groups an instance’s children under one unselectable row per slot', () => {
    registerCard(['header', 'body']);

    expect(flattenVisibleWidgets(definition([instance, widget('after')]), new Set())).toEqual([
      { id: 'card-1', depth: 0, selectable: true },
      { id: makeWidgetSlotId('card-1', 'header'), depth: 1, selectable: false },
      { id: 'w1', depth: 2, selectable: true },
      { id: makeWidgetSlotId('card-1', 'body'), depth: 1, selectable: false },
      { id: 'w2', depth: 2, selectable: true },
      { id: 'after', depth: 0, selectable: true },
    ]);
  });

  it('hides the children of a collapsed slot folder', () => {
    registerCard(['header', 'body']);
    const rows = flattenVisibleWidgets(
      definition([instance]),
      new Set([makeWidgetSlotId('card-1', 'header')]),
    );

    expect(rows.map((r) => r.id)).toEqual([
      'card-1',
      makeWidgetSlotId('card-1', 'header'),
      makeWidgetSlotId('card-1', 'body'),
      'w2',
    ]);
  });

  it('keeps an instance whose definition declares no slots a leaf', () => {
    registerCard([]);

    expect(flattenVisibleWidgets(definition([instance]), new Set()).map((r) => r.id)).toEqual([
      'card-1',
    ]);
  });
});
