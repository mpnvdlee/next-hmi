import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import type { WidgetConfig } from '@shared/types/config';
import { usePanelDiagnosticsStore, type Diagnostic } from '@config/hooks/usePanelDiagnostics';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { registerComponents } from '@hmi/registry/widgetRegistry';
import TreeNode from './TreeNode';
import { TreeSelectionContext } from './treeSelectionContext';

function diagnostic(widgetId: string, severity: 'error' | 'warning'): Diagnostic {
  return {
    artifactId: 'page-1',
    artifactKind: 'page',
    widgetId,
    propKey: 'value',
    code: 'var-unknown',
    severity,
    message: 'issue',
    breadcrumb: 'Widget › value',
    nested: false,
  };
}

const tree: WidgetConfig = {
  id: 'container-1',
  type: 'Container',
  name: 'Container',
  children: [{ id: 'widget-1', type: 'Text', name: 'Inner' }],
};

function renderTree(collapsed = new Set<string>(), comp: WidgetConfig = tree) {
  return render(
    <TreeSelectionContext.Provider
      value={{
        selectedIds: new Set<string>(),
        selectRow: () => {},
      }}
    >
      <DndContext>
        <TreeNode
          comp={comp}
          depth={0}
          collapsed={collapsed}
          onToggle={() => {}}
          onCtxMenu={() => {}}
        />
      </DndContext>
    </TreeSelectionContext.Provider>,
  );
}

describe('TreeNode diagnostics dot', () => {
  beforeEach(() => {
    useProjectDiagnosticsStore.setState({ swept: null, loading: false });
    usePanelDiagnosticsStore.getState().clear();
  });

  it('shows no dot when nothing is diagnosed', () => {
    renderTree();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('marks the widget that owns the diagnostic', () => {
    useProjectDiagnosticsStore.setState({ swept: [diagnostic('widget-1', 'error')] });
    renderTree();
    expect(screen.getByLabelText('This widget has an error')).toBeInTheDocument();
  });

  it('rolls a child diagnostic up to its collapsed container', () => {
    useProjectDiagnosticsStore.setState({ swept: [diagnostic('widget-1', 'warning')] });
    renderTree(new Set(['container-1']));

    const dots = screen.getAllByRole('img');
    expect(dots).toHaveLength(1);
    expect(dots[0]).toHaveAccessibleName('Contains a warning');
    expect(dots[0].className).toContain('cfg-tree-item__diag--warning');
  });
});

describe('TreeNode component slots', () => {
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

  it('groups children under one named section per slot', () => {
    registerCard(['header', 'body']);
    renderTree(new Set(), instance);

    expect(screen.getByText('Header')).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByText('In head')).toBeInTheDocument();
    expect(screen.getByText('In body')).toBeInTheDocument();
  });

  it('lists children flat when there is only one slot', () => {
    // Nothing to disambiguate — the instance reads as a plain container.
    registerCard(['body']);
    renderTree(new Set(), instance);

    expect(screen.queryByText('Body')).not.toBeInTheDocument();
    expect(screen.getByText('In body')).toBeInTheDocument();
  });

  it('stays a leaf when the definition declares no slots', () => {
    registerCard([]);
    renderTree(new Set(), instance);

    expect(screen.queryByText('In head')).not.toBeInTheDocument();
  });
});
