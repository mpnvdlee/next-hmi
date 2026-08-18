import type { AllAreas } from '@shared/store/configStoreHelpers';
import type { WidgetConfig } from '@shared/types/config';
import {
  canExtendWith,
  classifySelection,
  orderIdsByTree,
  topLevelSelection,
} from './selectionScope';

const widget = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
  id,
  type: children ? 'Container' : 'Button',
  name: id,
  ...(children ? { children } : {}),
});

function project(): AllAreas {
  return {
    header: [widget('head-btn')],
    footer: [],
    leftSidebar: [],
    rightSidebar: [],
    dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [widget('dlg-btn')] }],
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'One',
        sections: {
          content: [widget('a'), widget('box', [widget('inner'), widget('deep')]), widget('b')],
        },
      },
      {
        id: 'group-1',
        type: 'page-group',
        title: 'Group',
        children: [
          { id: 'page-2', type: 'page', title: 'Two', sections: { content: [widget('c')] } },
        ],
        header: [widget('group-btn')],
      },
    ],
  };
}

describe('orderIdsByTree', () => {
  it('returns widgets in tree order regardless of selection order', () => {
    expect(orderIdsByTree(['b', 'head-btn', 'inner'], project())).toEqual([
      'head-btn',
      'inner',
      'b',
    ]);
  });

  it('drops ids that are not widgets', () => {
    expect(orderIdsByTree(['page-1', 'a', 'dlg'], project())).toEqual(['a']);
  });

  it('covers shell, page-group chrome, nested pages and dialogs', () => {
    const ids = ['dlg-btn', 'c', 'group-btn', 'head-btn'];
    expect(orderIdsByTree(ids, project())).toEqual(['head-btn', 'group-btn', 'c', 'dlg-btn']);
  });
});

describe('topLevelSelection', () => {
  it('drops a descendant of another selected node', () => {
    expect(topLevelSelection(['box', 'inner'], project())).toEqual(['box']);
  });

  it('drops descendants at any depth', () => {
    expect(topLevelSelection(['deep', 'box', 'a'], project())).toEqual(['a', 'box']);
  });

  it('keeps siblings that share a parent', () => {
    expect(topLevelSelection(['deep', 'inner'], project())).toEqual(['inner', 'deep']);
  });
});

describe('classifySelection', () => {
  it('reports empty and single without walking the tree', () => {
    expect(classifySelection([], project())).toEqual({ kind: 'empty' });
    expect(classifySelection(['anything'], project())).toEqual({ kind: 'single', id: 'anything' });
  });

  it('resolves a widget-only set to comps in document order', () => {
    const scope = classifySelection(['b', 'a'], project());
    expect(scope.kind).toBe('multi-widget');
    if (scope.kind !== 'multi-widget') return;
    expect(scope.ids).toEqual(['a', 'b']);
    expect(scope.comps.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reports multi-mixed when one id is not a widget', () => {
    expect(classifySelection(['a', 'page-1'], project())).toEqual({
      kind: 'multi-mixed',
      ids: ['a', 'page-1'],
    });
  });
});

describe('canExtendWith', () => {
  it('extends a widget set with another widget', () => {
    expect(canExtendWith(['a'], 'b', project())).toBe(true);
  });

  it('starts over when nothing is selected yet', () => {
    expect(canExtendWith([], 'a', project())).toBe(true);
  });

  it('refuses a page, dialog or section row', () => {
    expect(canExtendWith(['a'], 'page-1', project())).toBe(false);
    expect(canExtendWith(['a'], '__header__', project())).toBe(false);
  });

  it('refuses to extend a selection that already holds a non-widget', () => {
    expect(canExtendWith(['page-1'], 'a', project())).toBe(false);
  });
});
