import { isContainerHostType, resolveWidgetMetadata } from '@hmi/registry/widgetRegistry';
import type {
  WidgetConfig,
  DialogConfig,
  PageConfig,
  PageGroupConfig,
  PageNode,
  ShellRegionId,
} from '@shared/types/config';
import { SHELL_REGION_IDS } from '@shared/types/config';
import { isPageGroup } from '@shared/utils/pageTree';
import { slugId } from '@shared/utils/id';
import { mapPreserving } from '@shared/store/configStoreHelpers';

export function makeDefaultPage(taken: Iterable<string> = []): PageConfig {
  return {
    id: slugId('New Page', taken),
    type: 'page',
    title: 'New Page',
    sections: { content: [] },
  };
}

export function makeDefaultPageGroup(taken: Iterable<string> = []): PageGroupConfig {
  return {
    id: slugId('New Page Group', taken),
    type: 'page-group',
    title: 'New Page Group',
    children: [],
    showChildPagesInMenu: false,
  };
}

export function makeDefaultDialog(taken: Iterable<string> = []): DialogConfig {
  return { id: slugId('New Dialog', taken), title: 'New Dialog', widgets: [] };
}

/** Every newly placed widget gets a `visible` property wired to the
 *  `$userGroups` source with an empty group list — visible to everyone by
 *  default, but one click away from gating by user group. */
function defaultVisibility(): Record<string, unknown> {
  return { visible: { $userGroups: { groups: [] } } };
}

export function makeDefaultContainer(taken: Iterable<string> = []): WidgetConfig {
  return {
    id: slugId('Container', taken),
    type: 'Container',
    name: 'Container',
    layout: { direction: 'row', gap: '0.5rem', wrap: true },
    properties: defaultVisibility(),
    children: [],
  };
}

export function makeComponentOfType(type: string, taken: Iterable<string> = []): WidgetConfig {
  const name = resolveWidgetMetadata(type).name;
  const comp: WidgetConfig = {
    id: slugId(name, taken),
    type,
    name,
    properties: defaultVisibility(),
  };
  if (isContainerHostType(type)) comp.children = [];
  return comp;
}

/**
 * Deep-map every component node in a tree, recursing into `children`.
 * Returns a new array; does not mutate the input.
 */
export function mapAllComponents(
  components: WidgetConfig[],
  fn: (c: WidgetConfig) => WidgetConfig,
): WidgetConfig[] {
  return mapPreserving(components, (c) => {
    const updated = fn(c);
    if (!updated.children) return updated;
    const children = mapAllComponents(updated.children as WidgetConfig[], fn);
    return children === updated.children ? updated : { ...updated, children };
  });
}

/**
 * Remove a component by id anywhere in the tree (recursive), returning a new array.
 */
export function removeComponentById(components: WidgetConfig[], id: string): WidgetConfig[] {
  return components
    .filter((c) => c.id !== id)
    .map((c) =>
      c.children ? { ...c, children: removeComponentById(c.children as WidgetConfig[], id) } : c,
    );
}

/**
 * Locates the immediate parent of a widget by id, returning enough context to
 * place a sibling next to it. The parent may be a container widget, a shell
 * region, a dialog, a page section, or a page-group header/footer array.
 */
export type WidgetParentInfo =
  | { kind: 'container'; parent: WidgetConfig; siblings: WidgetConfig[]; index: number }
  | { kind: 'shell-area'; region: ShellRegionId; siblings: WidgetConfig[]; index: number }
  | { kind: 'dialog'; dialogId: string; siblings: WidgetConfig[]; index: number }
  | {
      kind: 'page-section';
      pageId: string;
      sectionId: string;
      siblings: WidgetConfig[];
      index: number;
    }
  | {
      kind: 'page-group-chrome';
      groupId: string;
      area: 'header' | 'footer';
      siblings: WidgetConfig[];
      index: number;
    };

interface ProjectState {
  header: WidgetConfig[];
  footer: WidgetConfig[];
  leftSidebar: WidgetConfig[];
  rightSidebar: WidgetConfig[];
  pages: PageNode[];
  dialogs: DialogConfig[];
}

/** {@link findContainerParent}'s hit as the `container` variant — the same four
 *  fields whichever area the walk found it in. */
function containerInfo(found: { container: WidgetConfig; index: number }): WidgetParentInfo {
  return {
    kind: 'container',
    parent: found.container,
    siblings: found.container.children ?? [],
    index: found.index,
  };
}

export function findContainerParent(
  widgets: WidgetConfig[],
  id: string,
): { container: WidgetConfig; index: number } | null {
  for (const w of widgets) {
    if (!w.children) continue;
    const idx = w.children.findIndex((c) => c.id === id);
    if (idx !== -1) return { container: w, index: idx };
    const nested = findContainerParent(w.children, id);
    if (nested) return nested;
  }
  return null;
}

function findInPageNode(node: PageNode, id: string): WidgetParentInfo | null {
  if (isPageGroup(node)) {
    for (const area of ['header', 'footer'] as const) {
      const arr = node[area];
      if (!arr) continue;
      const idx = arr.findIndex((w) => w.id === id);
      if (idx !== -1) {
        return { kind: 'page-group-chrome', groupId: node.id, area, siblings: arr, index: idx };
      }
      const inContainer = findContainerParent(arr, id);
      if (inContainer) return containerInfo(inContainer);
    }
    for (const child of node.children) {
      const r = findInPageNode(child, id);
      if (r) return r;
    }
    return null;
  }

  for (const [sectionId, widgets] of Object.entries(node.sections)) {
    const idx = widgets.findIndex((c) => c.id === id);
    if (idx !== -1) {
      return {
        kind: 'page-section',
        pageId: node.id,
        sectionId,
        siblings: widgets,
        index: idx,
      };
    }
    const inContainer = findContainerParent(widgets, id);
    if (inContainer) return containerInfo(inContainer);
  }
  return null;
}

export function findParentInfo(state: ProjectState, id: string): WidgetParentInfo | null {
  for (const region of SHELL_REGION_IDS) {
    const arr = state[region];
    const idx = arr.findIndex((w) => w.id === id);
    if (idx !== -1) {
      return { kind: 'shell-area', region, siblings: arr, index: idx };
    }
    const inContainer = findContainerParent(arr, id);
    if (inContainer) return containerInfo(inContainer);
  }
  for (const dialog of state.dialogs) {
    const idx = dialog.widgets.findIndex((w) => w.id === id);
    if (idx !== -1) {
      return { kind: 'dialog', dialogId: dialog.id, siblings: dialog.widgets, index: idx };
    }
    const inContainer = findContainerParent(dialog.widgets, id);
    if (inContainer) return containerInfo(inContainer);
  }
  for (const node of state.pages) {
    const r = findInPageNode(node, id);
    if (r) return r;
  }
  return null;
}
