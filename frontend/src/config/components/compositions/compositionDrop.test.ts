import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import { resolveCompositionDrop } from './compositionDrop';
import { componentChildren, moveWidgetToIndex } from './compositionTreeOps';

const widget = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
  id,
  type: children ? 'Container' : 'Button',
  name: id,
  ...(children ? { children } : {}),
});

const definition = (): ComponentDefinition =>
  ({
    id: 'Card',
    name: 'Card',
    group: null,
    componentProperties: {},
    children: [widget('a'), widget('box', [widget('inner')]), widget('b')],
  }) as ComponentDefinition;

describe('resolveCompositionDrop', () => {
  it('drops inside a container on the middle band', () => {
    expect(resolveCompositionDrop(definition(), 'a', 'box', 'middle')).toEqual({
      nodeId: 'a',
      parentId: 'box',
      index: 1,
    });
  });

  it('places beside a row on the edge bands, allowing for the node leaving', () => {
    expect(resolveCompositionDrop(definition(), 'b', 'a', 'top')).toEqual({
      nodeId: 'b',
      parentId: null,
      index: 0,
    });
    expect(resolveCompositionDrop(definition(), 'a', 'b', 'bottom')).toEqual({
      nodeId: 'a',
      parentId: null,
      index: 2,
    });
  });

  it('refuses a container dropped into itself or its subtree', () => {
    expect(resolveCompositionDrop(definition(), 'box', 'inner', 'middle')).toBeNull();
    expect(resolveCompositionDrop(definition(), 'box', 'box', 'middle')).toBeNull();
  });

  it('refuses a drop inside a container that moves with the selection', () => {
    // Dragging 'a' while 'box' is selected too: the move sweeps 'box' out, so the
    // drop would land nowhere — moveWidgetsToIndex refuses it either way.
    expect(resolveCompositionDrop(definition(), 'a', 'box', 'middle', ['a', 'box'])).toBeNull();
    expect(resolveCompositionDrop(definition(), 'a', 'inner', 'top', ['a', 'box'])).toBeNull();
  });

  it('still places beside a moved container on the edge bands', () => {
    expect(resolveCompositionDrop(definition(), 'a', 'box', 'bottom', ['a', 'box'])).toEqual({
      nodeId: 'a',
      parentId: null,
      index: 0,
    });
  });

  it('allows for every moved sibling leaving the list, not only the dragged one', () => {
    expect(resolveCompositionDrop(definition(), 'a', 'b', 'bottom', ['a', 'box'])).toEqual({
      nodeId: 'a',
      parentId: null,
      index: 1,
    });
  });
});

describe('moveWidgetToIndex', () => {
  it('relocates a widget into a container, keeping its id', () => {
    const moved = moveWidgetToIndex(definition(), 'a', 'box', 0)!;
    expect(componentChildren(moved).map((w) => w.id)).toEqual(['box', 'b']);
    expect(componentChildren(moved)[0].children?.map((w) => w.id)).toEqual(['a', 'inner']);
  });

  it('reorders at the definition root', () => {
    const moved = moveWidgetToIndex(definition(), 'a', null, 2)!;
    expect(componentChildren(moved).map((w) => w.id)).toEqual(['box', 'b', 'a']);
  });

  it('refuses a move into its own subtree', () => {
    expect(moveWidgetToIndex(definition(), 'box', 'inner', 0)).toBeNull();
  });
});
