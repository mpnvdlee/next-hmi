import { act, renderHook } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import { useComponentStore } from '@shared/store/componentStore';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { PageNode, WidgetConfig } from '@shared/types/config';
import { collectWidgetTypes, warmWidgetModules } from '../registry/widgetRegistry';
import { useVariableStore } from '../store/variableStore';
import { collectProjectWidgetRoots, useProjectWidgetWarmup } from './useProjectWidgetWarmup';

vi.mock('../registry/widgetRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../registry/widgetRegistry')>()),
  warmWidgetModules: vi.fn(() => () => {}),
}));

function w(type: string, children?: WidgetConfig[]): WidgetConfig {
  return { id: `${type}-${Math.random()}`, type, name: type, ...(children ? { children } : {}) };
}

function page(id: string, sections: Record<string, WidgetConfig[]>): PageNode {
  return { id, type: 'page', title: id, sections } as unknown as PageNode;
}

function group(id: string, children: PageNode[], chrome: object = {}): PageNode {
  return { id, type: 'page-group', title: id, children, ...chrome } as unknown as PageNode;
}

describe('collectProjectWidgetRoots', () => {
  afterEach(() => {
    useConfigStore.setState({
      pages: [],
      dialogs: [],
      header: [],
      footer: [],
      leftSidebar: [],
      rightSidebar: [],
    });
    useComponentStore.setState({ components: [], draftComponents: {} });
  });

  it('reaches every page section, nested group chrome, dialogs, shell regions and components', () => {
    useComponentStore.setState({
      components: [
        { id: 'outer', name: 'Outer', children: [w('$component:inner')] },
        { id: 'inner', name: 'Inner', children: [w('InsideInner')] },
      ] as ComponentDefinition[],
    });
    useConfigStore.setState({
      header: [w('ShellHeader')],
      footer: [],
      leftSidebar: [w('ShellLeft')],
      rightSidebar: [],
      pages: [
        group(
          'plant',
          [
            group(
              'line',
              [
                page('deep', {
                  header: [w('PageHeader')],
                  content: [w('Content', [w('Nested')])],
                  footer: [w('PageFooter')],
                }),
              ],
              {
                footer: [w('LineFooter')],
              },
            ),
          ],
          { header: [w('PlantHeader')] },
        ),
      ],
      dialogs: [group('popups', [page('confirm', { content: [w('$component:outer')] })])],
    });

    const types = collectWidgetTypes(collectProjectWidgetRoots());

    expect([...types].sort()).toEqual(
      [
        'ShellHeader',
        'ShellLeft',
        'PlantHeader',
        'LineFooter',
        'PageHeader',
        'Content',
        'Nested',
        'PageFooter',
        '$component:outer',
        '$component:inner',
        'InsideInner',
      ].sort(),
    );
  });
});

describe('useProjectWidgetWarmup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(warmWidgetModules).mockClear();
    useVariableStore.setState({ contextReadyPageIds: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('waits for the page on screen to settle, then warms once', () => {
    const { rerender } = renderHook(({ id }) => useProjectWidgetWarmup(id), {
      initialProps: { id: 'a' as string | undefined },
    });
    expect(warmWidgetModules).not.toHaveBeenCalled();

    act(() => useVariableStore.setState({ contextReadyPageIds: ['a'] }));
    expect(warmWidgetModules).toHaveBeenCalledTimes(1);

    // A later navigation clears the ack for a new page; the warm-up is latched.
    act(() => useVariableStore.setState({ contextReadyPageIds: [] }));
    rerender({ id: 'b' });
    act(() => useVariableStore.setState({ contextReadyPageIds: ['b'] }));
    expect(warmWidgetModules).toHaveBeenCalledTimes(1);
  });

  it('starts after the grace when the page never settles', () => {
    renderHook(() => useProjectWidgetWarmup('a'));
    act(() => vi.advanceTimersByTime(2999));
    expect(warmWidgetModules).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(warmWidgetModules).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the shell is not up', () => {
    renderHook(() => useProjectWidgetWarmup(undefined));
    act(() => vi.advanceTimersByTime(10000));
    expect(warmWidgetModules).not.toHaveBeenCalled();
  });
});
