import { collectMovedWidgets, type AllAreas } from '@shared/store/configStoreHelpers';
import { shellSectionIdForRegion, type WidgetConfig } from '@shared/types/config';
import {
  sectionRowDropId,
  pageGroupSectionDropId,
  widgetSlotRowDropId,
} from '@shared/constants/editorSentinels';
import { bandOf, dropFeedback, resolveDropTarget, type DropBand } from './dropTarget';

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
    dialogs: [{ id: 'dlg', title: 'Dialog', widgets: [] }],
    pages: [
      {
        id: 'page-1',
        type: 'page',
        title: 'One',
        sections: { content: [widget('a'), widget('box', [widget('inner')]), widget('b')] },
      },
      {
        id: 'group-1',
        type: 'page-group',
        title: 'Group',
        children: [{ id: 'page-2', type: 'page', title: 'Two', sections: { content: [] } }],
        header: [],
      },
    ],
  };
}

describe('bandOf', () => {
  const rect = { top: 100, height: 20 };

  it('splits a row into before / inside / after', () => {
    expect(bandOf(rect, 102)).toBe('top');
    expect(bandOf(rect, 110)).toBe('middle');
    expect(bandOf(rect, 118)).toBe('bottom');
  });

  it('falls back to inside without a pointer (keyboard drag)', () => {
    expect(bandOf(rect, null)).toBe('middle');
  });
});

describe('resolveDropTarget', () => {
  it('drops a widget inside a container on the middle band', () => {
    expect(resolveDropTarget(project(), 'a', 'box', 'middle')).toEqual({
      kind: 'widget',
      nodeId: 'a',
      target: { kind: 'container', containerId: 'box' },
    });
  });

  it('places a widget beside a row on the edge bands', () => {
    expect(resolveDropTarget(project(), 'head-btn', 'b', 'top')).toEqual({
      kind: 'widget',
      nodeId: 'head-btn',
      target: { kind: 'page-section', pageId: 'page-1', sectionId: 'content' },
      index: 2,
      beside: true,
    });
    expect(resolveDropTarget(project(), 'head-btn', 'b', 'bottom')).toMatchObject({ index: 3 });
  });

  it('accounts for the dragged node leaving its own list', () => {
    // 'a' sits at 0, so landing after 'b' (index 2) is index 2, not 3.
    expect(resolveDropTarget(project(), 'a', 'b', 'bottom')).toMatchObject({ index: 2 });
  });

  it('refuses a container dropped into its own subtree', () => {
    expect(resolveDropTarget(project(), 'box', 'inner', 'middle')).toBeNull();
    expect(resolveDropTarget(project(), 'box', 'box', 'top')).toBeNull();
  });

  it('refuses a drop into a widget that moves with the dragged one', () => {
    // 'box' is selected too, so the row under the pointer leaves the tree with it —
    // the whole batch would be swept out and never re-inserted.
    expect(resolveDropTarget(project(), 'a', 'inner', 'middle', ['a', 'box'])).toBeNull();
    expect(resolveDropTarget(project(), 'a', 'inner', 'top', ['a', 'box'])).toBeNull();
    expect(resolveDropTarget(project(), 'a', 'box', 'middle', ['a', 'box'])).toBeNull();
    expect(
      resolveDropTarget(project(), 'a', widgetSlotRowDropId('box', 'body'), 'middle', ['a', 'box']),
    ).toBeNull();
  });

  it('still lands beside a sibling that moves with it', () => {
    // The pair leaves 'a's own place free, so the edge of a moved row is still a
    // position — only dropping *inside* a moved widget is impossible.
    expect(resolveDropTarget(project(), 'b', 'a', 'top', ['a', 'b'])).toMatchObject({
      target: { kind: 'page-section', pageId: 'page-1', sectionId: 'content' },
      index: 0,
      beside: true,
    });
  });

  it('accounts for every moved node leaving the list, not only the dragged one', () => {
    // 'a' and 'box' both sit above 'b', so landing after it is index 1 post-sweep.
    expect(resolveDropTarget(project(), 'a', 'b', 'bottom', ['a', 'box'])).toMatchObject({
      index: 1,
    });
  });

  it('reads section, slot and page-group chrome drop ids as "inside"', () => {
    expect(resolveDropTarget(project(), 'a', sectionRowDropId('page-1', 'content'), 'top')).toEqual(
      {
        kind: 'widget',
        nodeId: 'a',
        target: { kind: 'page-section', pageId: 'page-1', sectionId: 'content' },
      },
    );
    expect(
      resolveDropTarget(project(), 'a', pageGroupSectionDropId('group-1', 'header'), 'bottom'),
    ).toEqual({
      kind: 'widget',
      nodeId: 'a',
      target: { kind: 'page-group-chrome', groupId: 'group-1', area: 'header' },
    });
    expect(
      resolveDropTarget(project(), 'a', widgetSlotRowDropId('card', 'body'), 'middle'),
    ).toEqual({
      kind: 'widget',
      nodeId: 'a',
      target: { kind: 'container', containerId: 'card', slot: 'body' },
    });
  });

  it('drops a widget onto a page row into that page', () => {
    expect(resolveDropTarget(project(), 'head-btn', 'page-1', 'middle')).toMatchObject({
      kind: 'widget',
      target: { kind: 'page-section', pageId: 'page-1', sectionId: 'content' },
    });
  });

  it('drops a widget onto a dialog row into that dialog', () => {
    expect(resolveDropTarget(project(), 'a', 'dlg', 'middle')).toEqual({
      kind: 'widget',
      nodeId: 'a',
      target: { kind: 'dialog', dialogId: 'dlg' },
    });
  });

  it('moves a page into a group, and beside a page', () => {
    expect(resolveDropTarget(project(), 'page-1', 'group-1', 'middle')).toEqual({
      kind: 'page',
      nodeId: 'page-1',
      groupId: 'group-1',
    });
    expect(resolveDropTarget(project(), 'page-1', 'page-2', 'bottom')).toEqual({
      kind: 'page',
      nodeId: 'page-1',
      groupId: 'group-1',
      index: 1,
      beside: true,
    });
  });

  it('rejects mixing pages and widgets', () => {
    expect(resolveDropTarget(project(), 'page-1', 'box', 'middle')).toBeNull();
    expect(resolveDropTarget(project(), 'a', 'group-1', 'middle')).toBeNull();
  });

  it('refuses a group dropped into its own descendant', () => {
    expect(resolveDropTarget(project(), 'group-1', 'page-2', 'middle')).toBeNull();
  });

  it('resolves the same plan from a precomputed moved set as from the ids', () => {
    const cases: { activeId: string; overId: string; band: DropBand; movedIds: string[] }[] = [
      { activeId: 'a', overId: 'box', band: 'middle', movedIds: ['a'] },
      { activeId: 'a', overId: 'b', band: 'bottom', movedIds: ['a', 'box'] },
      { activeId: 'a', overId: 'inner', band: 'middle', movedIds: ['a', 'box'] },
      { activeId: 'b', overId: 'a', band: 'top', movedIds: ['a', 'b'] },
      {
        activeId: 'a',
        overId: widgetSlotRowDropId('box', 'body'),
        band: 'middle',
        movedIds: ['a', 'box'],
      },
      { activeId: 'head-btn', overId: 'page-1', band: 'middle', movedIds: ['head-btn'] },
      { activeId: 'page-1', overId: 'page-2', band: 'bottom', movedIds: ['page-1'] },
    ];
    for (const { activeId, overId, band, movedIds } of cases) {
      const p = project();
      expect(
        resolveDropTarget(p, activeId, overId, band, collectMovedWidgets(p, movedIds)),
      ).toEqual(resolveDropTarget(p, activeId, overId, band, movedIds));
    }
  });

  it('uses a precomputed set for a drag that started outside the selection', () => {
    // The row under the pointer is not selected, so only it moves — 'box' stays
    // put and can still host the drop.
    const p = project();
    expect(resolveDropTarget(p, 'a', 'box', 'middle', collectMovedWidgets(p, ['a']))).toEqual(
      resolveDropTarget(p, 'a', 'box', 'middle'),
    );
  });

  it('takes a widget into a shell area from the section row and the empty placeholder', () => {
    const expected = {
      kind: 'widget',
      nodeId: 'a',
      target: { kind: 'shell-area', region: 'header' },
    };
    expect(resolveDropTarget(project(), 'a', 'header', 'middle')).toEqual(expected);
    expect(resolveDropTarget(project(), 'a', shellSectionIdForRegion('header'), 'middle')).toEqual(
      expected,
    );
  });
});

describe('dropFeedback', () => {
  it('shows an edge, not a ring, when a middle-band hover falls back to "beside"', () => {
    // 'b' is a leaf: the middle band cannot drop inside it.
    const plan = resolveDropTarget(project(), 'head-btn', 'b', 'middle');
    expect(dropFeedback(plan, 'middle')).toEqual({ edge: 'bottom', into: false });
  });

  it('shows a ring for a row that hosts the drop, index or not', () => {
    expect(dropFeedback(resolveDropTarget(project(), 'a', 'box', 'middle'), 'middle')).toEqual({
      into: true,
    });
    // A page row hosts the drop and still names an index — an edge band over it
    // is still "inside".
    expect(
      dropFeedback(resolveDropTarget(project(), 'head-btn', 'page-1', 'bottom'), 'bottom'),
    ).toEqual({ into: true });
  });
});
