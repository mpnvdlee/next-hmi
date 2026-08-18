import { renderHook } from '@testing-library/react';
import type { WidgetConfig } from '@shared/types/config';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import { usePanelDiagnosticsStore, type Diagnostic } from './usePanelDiagnostics';
import {
  shellAreaNodeIdFor,
  subtreeSeverity,
  useDiagnosticIndex,
  useProjectDiagnosticsStore,
  useWidgetSeverities,
} from './useProjectDiagnostics';

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    artifactId: 'page-1',
    artifactKind: 'page',
    widgetId: null,
    propKey: null,
    code: '',
    severity: 'warning',
    message: 'issue',
    breadcrumb: '(root)',
    nested: false,
    ...overrides,
  };
}

function widget(id: string, children?: WidgetConfig[]): WidgetConfig {
  return { id, type: 'Container', name: id, ...(children ? { children } : {}) };
}

beforeEach(() => {
  useProjectDiagnosticsStore.setState({ swept: null, loading: false });
  usePanelDiagnosticsStore.getState().clear();
});

describe('subtreeSeverity', () => {
  const tree = widget('root', [widget('a', [widget('a1')]), widget('b')]);

  it('is undefined when nothing in the subtree is diagnosed', () => {
    expect(subtreeSeverity(tree, new Map([['elsewhere', 'error']]))).toBeUndefined();
  });

  it('rolls a descendant up to every ancestor', () => {
    const marks = new Map<string, 'error' | 'warning'>([['a1', 'error']]);
    expect(subtreeSeverity(tree, marks)).toBe('error');
    expect(subtreeSeverity(tree.children![0], marks)).toBe('error');
    expect(subtreeSeverity(tree.children![1], marks)).toBeUndefined();
  });

  it('lets an error outrank a warning found elsewhere in the subtree', () => {
    const marks = new Map<string, 'error' | 'warning'>([
      ['a1', 'warning'],
      ['b', 'error'],
    ]);
    expect(subtreeSeverity(tree, marks)).toBe('error');
  });
});

describe('shellAreaNodeIdFor', () => {
  const areas = {
    header: [widget('h1')],
    footer: [],
    leftSidebar: [widget('l1', [widget('l2')])],
    rightSidebar: [],
  };

  it('finds the area holding the offending widget, at any depth', () => {
    expect(shellAreaNodeIdFor('h1', areas)).toBe(EDITOR_NODE_IDS.HEADER);
    expect(shellAreaNodeIdFor('l2', areas)).toBe(EDITOR_NODE_IDS.LEFT_SIDEBAR);
  });

  it('passes through the reserved node id the backend stamps on region settings', () => {
    expect(shellAreaNodeIdFor(EDITOR_NODE_IDS.FOOTER, areas)).toBe(EDITOR_NODE_IDS.FOOTER);
  });

  it('is null for a widget that belongs to no area', () => {
    expect(shellAreaNodeIdFor('stranger', areas)).toBeNull();
    expect(shellAreaNodeIdFor(null, areas)).toBeNull();
  });
});

describe('useWidgetSeverities', () => {
  it('takes the worst severity per widget and returns a stable map', () => {
    useProjectDiagnosticsStore.setState({
      swept: [
        diagnostic({ widgetId: 'w1', severity: 'warning' }),
        diagnostic({ widgetId: 'w1', severity: 'error' }),
        diagnostic({ widgetId: 'w2', severity: 'warning' }),
      ],
    });
    const { result, rerender } = renderHook(() => useWidgetSeverities());
    expect(result.current.get('w1')).toBe('error');
    expect(result.current.get('w2')).toBe('warning');

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useDiagnosticIndex', () => {
  it('swaps the open artifact rows for the live verdict, keeping the rest', () => {
    useProjectDiagnosticsStore.setState({
      swept: [
        diagnostic({ artifactId: 'page-1', message: 'stale' }),
        diagnostic({ artifactId: 'page-2', message: 'other' }),
      ],
    });
    usePanelDiagnosticsStore
      .getState()
      .setDiagnostics(
        [diagnostic({ artifactId: 'page-1', severity: 'error', message: 'live' })],
        'page:page-1',
      );

    const { result } = renderHook(() => useDiagnosticIndex());
    expect(result.current.all.map((d) => d.message)).toEqual(['other', 'live']);
    expect(result.current.errorCount).toBe(1);
    expect(result.current.warningCount).toBe(1);
  });

  it('reports pending until the first sweep lands', () => {
    const { result, rerender } = renderHook(() => useDiagnosticIndex());
    expect(result.current.pending).toBe(true);

    useProjectDiagnosticsStore.setState({ swept: [] });
    rerender();
    expect(result.current.pending).toBe(false);
  });
});
