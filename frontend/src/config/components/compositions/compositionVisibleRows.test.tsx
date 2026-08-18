import { render } from '@testing-library/react';
import { registerComponents } from '@hmi/registry/widgetRegistry';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import { useComponentEditorStore } from '@config/store/componentEditorStore';
import { makeWidgetSlotId } from '@shared/constants/editorSentinels';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import CompositionTree from './CompositionTree';
import { flattenVisibleWidgets } from './compositionTreeOps';

/**
 * The compositions counterpart of `selectRow.test.tsx`'s agreement check: a
 * Shift-range slices `flattenVisibleWidgets`, so it has to produce exactly the
 * rows the tree renders. Rendering the real tree here makes drift fail loudly.
 */

const cardDefinition = {
  id: 'card',
  name: 'Card',
  group: null,
  componentProperties: {},
  children: [
    { id: 's0', type: 'ComponentSlot', name: 'header', properties: { slot: 'header' } },
    { id: 's1', type: 'ComponentSlot', name: 'body', properties: { slot: 'body' } },
  ],
} as unknown as ComponentDefinition;

const panel: ComponentDefinition = {
  id: 'panel',
  name: 'Panel',
  group: null,
  componentProperties: {},
  children: [
    { id: 'a', type: 'Button', name: 'a' },
    {
      id: 'box',
      type: 'Container',
      name: 'box',
      children: [{ id: 'inner', type: 'Button', name: 'inner' }],
    },
    {
      id: 'card-1',
      type: '$component:card',
      name: 'Card',
      children: [
        { id: 'w1', type: 'Text', name: 'In head', slot: 'header' },
        { id: 'w2', type: 'Text', name: 'In body', slot: 'body' },
      ],
    },
    // A type the tree draws as a leaf, so the children it carries stay hidden.
    {
      id: 'leaf',
      type: 'Button',
      name: 'leaf',
      children: [{ id: 'hidden', type: 'Text', name: 'hidden' }],
    },
  ] as WidgetConfig[],
};

/** The definition's widget rows start two levels in: the Components root row,
 *  then the definition row. */
const WIDGET_ROW_DEPTH_OFFSET = 2;

function renderTree() {
  return render(
    <CompositionTree
      widgets={[panel]}
      folders={[]}
      selectedId={null}
      selectedIds={[]}
      onSelectWidget={() => {}}
      onOpenWidget={() => {}}
      onSelectComponent={() => {}}
      onSelectRow={() => {}}
      onTreeAction={() => {}}
      onDeleteWidget={() => {}}
      onCreateWidget={() => {}}
      onCreateFolder={() => {}}
      onDeleteFolder={() => {}}
      onCopyWidget={() => {}}
      onPasteWidget={() => {}}
      onMoveWidget={() => {}}
    />,
  );
}

function renderedDepths(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.cfg-tree-item')).map((el) =>
    Number((el as HTMLElement).style.getPropertyValue('--tree-depth') || '0'),
  );
}

beforeEach(() => {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  useComponentEditorStore.setState({ collapsedIds: new Set() });
  registerComponents([cardDefinition]);
});

afterEach(() => registerComponents([]));

describe('flattenVisibleWidgets agreement with the rendered composition tree', () => {
  it('produces one row per rendered row, at the same depths', () => {
    const { container } = renderTree();

    const rows = flattenVisibleWidgets(panel, new Set());

    expect(renderedDepths(container)).toEqual([
      0,
      1,
      ...rows.map((row) => row.depth + WIDGET_ROW_DEPTH_OFFSET),
    ]);
  });

  it('still agrees with a container and a slot folder collapsed', () => {
    const collapsed = new Set(['box', makeWidgetSlotId('card-1', 'header')]);
    useComponentEditorStore.setState({ collapsedIds: collapsed });
    const { container } = renderTree();

    const rows = flattenVisibleWidgets(panel, collapsed);

    expect(renderedDepths(container)).toEqual([
      0,
      1,
      ...rows.map((row) => row.depth + WIDGET_ROW_DEPTH_OFFSET),
    ]);
  });
});
