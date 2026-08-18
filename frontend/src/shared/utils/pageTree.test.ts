import type {
  WidgetConfig,
  PageConfig,
  PageGroupChild,
  PageGroupConfig,
} from '@shared/types/config';
import {
  findFirstPage,
  findOwningPage,
  findPageById,
  findPageGroupById,
  findParentPageGroup,
  flattenPages,
  insertPageIntoPageGroup,
  isPageGroup,
  mapPageGroupChrome,
  mapPages,
  normalizePageNode,
  normalizePageNodes,
  pageHasExplicitSections,
  pageSectionGroups,
  removePageGroup,
  removePageNode,
  replacePageGroupChildren,
  resolvePageContext,
  treeContains,
  updatePageGroupChrome,
} from './pageTree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(id: string, widgets: WidgetConfig[] = []): PageConfig {
  return { id, title: `Page ${id}`, type: 'page', sections: { content: widgets } };
}

function makeGroup(id: string, children: PageGroupChild[] = []): PageGroupConfig {
  return { id, title: `Group ${id}`, type: 'page-group', children };
}

function makeComponent(id: string): WidgetConfig {
  return { id, type: 'box', name: id };
}

// ---------------------------------------------------------------------------
// isPageGroup
// ---------------------------------------------------------------------------
describe('isPageGroup', () => {
  it('returns true for page-group nodes', () => {
    expect(isPageGroup(makeGroup('g1'))).toBe(true);
  });

  it('returns false for page nodes', () => {
    expect(isPageGroup(makePage('p1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pageHasExplicitSections
// ---------------------------------------------------------------------------
describe('pageHasExplicitSections', () => {
  it('returns false for a page with no header/footer', () => {
    expect(pageHasExplicitSections(makePage('p1'))).toBe(false);
  });

  it('returns true when showHeader is set', () => {
    expect(pageHasExplicitSections({ ...makePage('p1'), showHeader: true })).toBe(true);
  });

  it('returns true when showFooter is set', () => {
    expect(pageHasExplicitSections({ ...makePage('p1'), showFooter: true })).toBe(true);
  });

  it('returns false for a page-group even if it looks page-like', () => {
    expect(pageHasExplicitSections(makeGroup('g1'))).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(pageHasExplicitSections(null)).toBe(false);
    expect(pageHasExplicitSections(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pageSectionGroups
// ---------------------------------------------------------------------------
describe('pageSectionGroups', () => {
  it('always includes content', () => {
    expect(pageSectionGroups(makePage('p1'))).toEqual([{ id: 'content', label: 'Content' }]);
  });

  it('includes header/footer only when their show flags are set, content always in the middle', () => {
    const page = { ...makePage('p1'), showHeader: true, showFooter: true };
    expect(pageSectionGroups(page)).toEqual([
      { id: 'header', label: 'Header' },
      { id: 'content', label: 'Content' },
      { id: 'footer', label: 'Footer' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizePageNode
// ---------------------------------------------------------------------------
describe('normalizePageNode', () => {
  it('returns null for null input', () => {
    expect(normalizePageNode(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(normalizePageNode('string')).toBeNull();
    expect(normalizePageNode(42)).toBeNull();
    expect(normalizePageNode(undefined)).toBeNull();
  });

  it('returns null when id is missing', () => {
    expect(normalizePageNode({ title: 'Hello' })).toBeNull();
  });

  it('returns null when title is missing', () => {
    expect(normalizePageNode({ id: 'p1' })).toBeNull();
  });

  it('normalizes a minimal page node', () => {
    const result = normalizePageNode({ id: 'p1', title: 'Page 1' });
    expect(result).not.toBeNull();
    expect(result?.id).toBe('p1');
    expect(result?.title).toBe('Page 1');
    expect(isPageGroup(result!)).toBe(false);
  });

  it('preserves the icon field', () => {
    const result = normalizePageNode({ id: 'p1', title: 'Page 1', icon: 'house' });
    expect(result?.icon).toBe('house');
  });

  it('discards a non-string icon', () => {
    const result = normalizePageNode({ id: 'p1', title: 'Page 1', icon: 99 });
    expect(result?.icon).toBeUndefined();
  });

  it('normalizes a page-group node with pages as children', () => {
    const raw = {
      id: 'g1',
      title: 'Group 1',
      type: 'page-group',
      children: [{ id: 'p1', title: 'Child page' }],
    };
    const result = normalizePageNode(raw);
    expect(result).not.toBeNull();
    expect(isPageGroup(result!)).toBe(true);
    const group = result as PageGroupConfig;
    expect(group.children).toHaveLength(1);
    expect(group.children[0].id).toBe('p1');
  });

  it('page-group keeps nested page-group children', () => {
    const raw = {
      id: 'g1',
      title: 'Group',
      type: 'page-group',
      children: [
        { id: 'p1', title: 'Page' },
        { id: 'g2', title: 'Nested group', type: 'page-group', children: [] },
      ],
    };
    const result = normalizePageNode(raw) as PageGroupConfig;
    expect(result.children).toHaveLength(2);
    expect(result.children[0].id).toBe('p1');
    expect(result.children[1].id).toBe('g2');
  });

  it('normalizes page-group with showChildPagesInMenu boolean', () => {
    const raw = {
      id: 'g1',
      title: 'Group',
      type: 'page-group',
      children: [],
      showChildPagesInMenu: true,
    };
    const result = normalizePageNode(raw) as PageGroupConfig;
    expect(result.showChildPagesInMenu).toBe(true);
  });

  it('defaults to an empty content section when no sections are present', () => {
    const result = normalizePageNode({ id: 'p1', title: 'Page' }) as PageConfig;
    expect(result.sections).toEqual({ content: [] });
    expect(result.showHeader).toBeUndefined();
    expect(result.showFooter).toBeUndefined();
  });

  it('parses showHeader/showFooter and section contents', () => {
    const raw = {
      id: 'p1',
      title: 'Tab',
      showHeader: true,
      showFooter: true,
      sections: {
        header: [{ id: 'w1', type: 'Button' }],
        content: [{ id: 'w2', type: 'Button' }],
        footer: [{ id: 'w3', type: 'Button' }],
      },
    };
    const result = normalizePageNode(raw) as PageConfig;
    expect(result.showHeader).toBe(true);
    expect(result.showFooter).toBe(true);
    expect(result.sections.header).toHaveLength(1);
    expect(result.sections.content).toHaveLength(1);
    expect(result.sections.footer).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// normalizePageNodes
// ---------------------------------------------------------------------------
describe('normalizePageNodes', () => {
  it('maps and filters nulls', () => {
    const result = normalizePageNodes([
      { id: 'p1', title: 'Page 1' },
      null,
      { id: 'p2', title: 'Page 2' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.id)).toEqual(['p1', 'p2']);
  });

  it('returns empty array for empty input', () => {
    expect(normalizePageNodes([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// flattenPages
// ---------------------------------------------------------------------------
describe('flattenPages', () => {
  it('returns pages from a flat list', () => {
    const pages = flattenPages([makePage('p1'), makePage('p2')]);
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('returns children of a top-level page-group', () => {
    const nodes = [makeGroup('g1', [makePage('p1'), makePage('p2')])];
    const pages = flattenPages(nodes);
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('walks into nested page-groups inside a page-group', () => {
    const inner = makeGroup('inner', [makePage('p1'), makePage('p2')]);
    const outer = makeGroup('outer', [inner, makePage('p3')]);
    const pages = flattenPages([outer]);
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('handles mixed nodes', () => {
    const nodes = [makePage('p1'), makeGroup('g1', [makePage('p2')]), makePage('p3')];
    const pages = flattenPages(nodes);
    expect(pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });
});

// ---------------------------------------------------------------------------
// findFirstPage
// ---------------------------------------------------------------------------
describe('findFirstPage', () => {
  it('returns the first page in a flat list', () => {
    expect(findFirstPage([makePage('p1'), makePage('p2')])?.id).toBe('p1');
  });

  it('returns the first child of the first non-empty group', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    expect(findFirstPage(nodes)?.id).toBe('p1');
  });

  it('skips empty groups and returns first page after them', () => {
    const nodes = [makeGroup('g1', []), makePage('p1')];
    expect(findFirstPage(nodes)?.id).toBe('p1');
  });

  it('returns undefined for empty list', () => {
    expect(findFirstPage([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findPageById
// ---------------------------------------------------------------------------
describe('findPageById', () => {
  it('finds a top-level page', () => {
    expect(findPageById([makePage('p1')], 'p1')?.id).toBe('p1');
  });

  it('finds a page inside a top-level page-group', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    expect(findPageById(nodes, 'p1')?.id).toBe('p1');
  });

  it('does not return a page-group (only pages)', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    expect(findPageById(nodes, 'g1')).toBeUndefined();
  });

  it('returns undefined when not found', () => {
    expect(findPageById([makePage('p1')], 'missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findParentPageGroup
// ---------------------------------------------------------------------------
describe('findParentPageGroup', () => {
  it('finds the top-level page-group that directly contains the page', () => {
    const nodes = [makeGroup('g1', [makePage('p1'), makePage('p2')])];
    expect(findParentPageGroup(nodes, 'p1')?.id).toBe('g1');
  });

  it('returns undefined for a page with no parent group', () => {
    expect(findParentPageGroup([makePage('p1')], 'p1')).toBeUndefined();
  });

  it('returns undefined when page id does not exist', () => {
    expect(findParentPageGroup([makePage('p1')], 'missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findPageGroupById
// ---------------------------------------------------------------------------
describe('findPageGroupById', () => {
  it('finds a top-level page-group', () => {
    const nodes = [makeGroup('g1')];
    expect(findPageGroupById(nodes, 'g1')?.id).toBe('g1');
  });

  it('returns undefined for a page id', () => {
    const nodes = [makePage('p1')];
    expect(findPageGroupById(nodes, 'p1')).toBeUndefined();
  });

  it('returns undefined when not found', () => {
    expect(findPageGroupById([makeGroup('g1')], 'missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// removePageNode
// ---------------------------------------------------------------------------
describe('removePageNode', () => {
  it('removes a top-level page', () => {
    const { nodes, removed } = removePageNode([makePage('p1'), makePage('p2')], 'p1');
    expect(nodes.map((n) => n.id)).toEqual(['p2']);
    expect(removed?.id).toBe('p1');
  });

  it('removes a top-level page-group', () => {
    const { nodes, removed } = removePageNode([makeGroup('g1'), makePage('p1')], 'g1');
    expect(nodes.map((n) => n.id)).toEqual(['p1']);
    expect(removed?.id).toBe('g1');
  });

  it('removes a page inside a top-level group', () => {
    const nodes = [makeGroup('g1', [makePage('p1'), makePage('p2')])];
    const { nodes: result, removed } = removePageNode(nodes, 'p1');
    const group = result[0] as PageGroupConfig;
    expect(group.children.map((c) => c.id)).toEqual(['p2']);
    expect(removed?.id).toBe('p1');
  });

  it('returns null removed when id is not found', () => {
    const { nodes, removed } = removePageNode([makePage('p1')], 'missing');
    expect(nodes).toHaveLength(1);
    expect(removed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertPageIntoPageGroup
// ---------------------------------------------------------------------------
describe('insertPageIntoPageGroup', () => {
  it('appends a page into a top-level group matching the id', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    const result = insertPageIntoPageGroup(nodes, 'g1', makePage('p2'));
    const group = result[0] as PageGroupConfig;
    expect(group.children.map((c) => c.id)).toEqual(['p1', 'p2']);
  });

  it('does not modify nodes when group id is not found', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    const result = insertPageIntoPageGroup(nodes, 'missing', makePage('p2'));
    const group = result[0] as PageGroupConfig;
    expect(group.children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// replacePageGroupChildren
// ---------------------------------------------------------------------------
describe('replacePageGroupChildren', () => {
  it('replaces children of a top-level page-group', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    const result = replacePageGroupChildren(nodes, 'g1', [makePage('p2'), makePage('p3')]);
    const group = result[0] as PageGroupConfig;
    expect(group.children.map((c) => c.id)).toEqual(['p2', 'p3']);
  });

  it('does not modify when group id not found', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    const result = replacePageGroupChildren(nodes, 'missing', [makePage('p2')]);
    const group = result[0] as PageGroupConfig;
    expect(group.children.map((c) => c.id)).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// removePageGroup
// ---------------------------------------------------------------------------
describe('removePageGroup', () => {
  it('removes a top-level page-group', () => {
    const nodes = [makeGroup('g1'), makePage('p1')];
    const result = removePageGroup(nodes, 'g1');
    expect(result.map((n) => n.id)).toEqual(['p1']);
  });

  it('does not modify when group id not found', () => {
    const nodes = [makePage('p1')];
    const result = removePageGroup(nodes, 'missing');
    expect(result.map((n) => n.id)).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// mapPages
// ---------------------------------------------------------------------------
describe('mapPages', () => {
  it('applies the mapper to each page', () => {
    const nodes = [makePage('p1'), makePage('p2')];
    const result = mapPages(nodes, (page) => ({ ...page, title: 'renamed' }));
    expect(result.map((n) => n.title)).toEqual(['renamed', 'renamed']);
  });

  it('applies the mapper to pages inside a top-level group', () => {
    const nodes = [makeGroup('g1', [makePage('p1')])];
    const result = mapPages(nodes, (page) => ({ ...page, title: 'renamed' }));
    const group = result[0] as PageGroupConfig;
    expect(group.children[0].title).toBe('renamed');
    expect(group.title).toBe('Group g1'); // group itself is not remapped
  });
});

// ---------------------------------------------------------------------------
// mapPageGroupChrome
// ---------------------------------------------------------------------------
describe('mapPageGroupChrome', () => {
  it('applies mapFn to a defined header/footer', () => {
    const group: PageGroupConfig = {
      ...makeGroup('g1'),
      header: [makeComponent('h1')],
      footer: [makeComponent('f1')],
    };
    const result = mapPageGroupChrome([group], (widgets) => [...widgets, makeComponent('added')]);
    const g = result[0] as PageGroupConfig;
    expect(g.header?.map((w) => w.id)).toEqual(['h1', 'added']);
    expect(g.footer?.map((w) => w.id)).toEqual(['f1', 'added']);
  });

  it('leaves an undefined header/footer as undefined (does not call mapFn)', () => {
    const mapFn = vi.fn((widgets: WidgetConfig[]) => widgets);
    const result = mapPageGroupChrome([makeGroup('g1')], mapFn);
    const g = result[0] as PageGroupConfig;
    expect(g.header).toBeUndefined();
    expect(g.footer).toBeUndefined();
    expect(mapFn).not.toHaveBeenCalled();
  });

  it('recurses into nested groups', () => {
    const inner: PageGroupConfig = { ...makeGroup('inner'), header: [makeComponent('h1')] };
    const outer = makeGroup('outer', [inner]);
    const result = mapPageGroupChrome([outer], (widgets) => [...widgets, makeComponent('added')]);
    const outerResult = result[0] as PageGroupConfig;
    const innerResult = outerResult.children[0] as PageGroupConfig;
    expect(innerResult.header?.map((w) => w.id)).toEqual(['h1', 'added']);
  });

  it('leaves plain pages untouched', () => {
    const result = mapPageGroupChrome([makePage('p1')], (widgets) => [
      ...widgets,
      makeComponent('added'),
    ]);
    expect(result[0]).toEqual(makePage('p1'));
  });
});

// ---------------------------------------------------------------------------
// updatePageGroupChrome
// ---------------------------------------------------------------------------
describe('updatePageGroupChrome', () => {
  it("updates the matched group's area, defaulting undefined to []", () => {
    const result = updatePageGroupChrome([makeGroup('g1')], 'g1', 'header', (widgets) => [
      ...widgets,
      makeComponent('h1'),
    ]);
    const g = result[0] as PageGroupConfig;
    expect(g.header?.map((w) => w.id)).toEqual(['h1']);
    expect(g.footer).toBeUndefined();
  });

  it('does not touch groups that do not match the id', () => {
    const nodes = [makeGroup('g1'), makeGroup('g2')];
    const result = updatePageGroupChrome(nodes, 'g1', 'header', (widgets) => [
      ...widgets,
      makeComponent('h1'),
    ]);
    const g2 = result[1] as PageGroupConfig;
    expect(g2.header).toBeUndefined();
  });

  it('finds and updates a nested group by id', () => {
    const inner = makeGroup('inner');
    const outer = makeGroup('outer', [inner]);
    const result = updatePageGroupChrome([outer], 'inner', 'footer', (widgets) => [
      ...widgets,
      makeComponent('f1'),
    ]);
    const outerResult = result[0] as PageGroupConfig;
    const innerResult = outerResult.children[0] as PageGroupConfig;
    expect(innerResult.footer?.map((w) => w.id)).toEqual(['f1']);
  });

  it('leaves the tree unchanged in content when groupId is not found', () => {
    const nodes = [makeGroup('g1')];
    const result = updatePageGroupChrome(nodes, 'missing', 'header', (widgets) => [
      ...widgets,
      makeComponent('h1'),
    ]);
    expect(result).toEqual(nodes);
  });
});

// ---------------------------------------------------------------------------
// treeContains
// ---------------------------------------------------------------------------
describe('treeContains', () => {
  it('returns true when component is in the flat list', () => {
    expect(treeContains([makeComponent('c1')], 'c1')).toBe(true);
  });

  it('returns true when component is nested', () => {
    const parent: WidgetConfig = {
      id: 'parent',
      type: 'box',
      name: 'parent',
      children: [makeComponent('c1')],
    };
    expect(treeContains([parent], 'c1')).toBe(true);
  });

  it('returns false when component is not found', () => {
    expect(treeContains([makeComponent('c1')], 'missing')).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(treeContains([], 'c1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findOwningPage
// ---------------------------------------------------------------------------
describe('findOwningPage', () => {
  it('finds the page that directly contains the component', () => {
    const page = makePage('p1', [makeComponent('c1')]);
    expect(findOwningPage([page], 'c1')?.id).toBe('p1');
  });

  it('returns undefined when component is not in any page', () => {
    const page = makePage('p1');
    expect(findOwningPage([page], 'missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePageContext
// ---------------------------------------------------------------------------
describe('resolvePageContext', () => {
  it('returns the first page when no id is provided', () => {
    const nodes = [makePage('p1'), makePage('p2')];
    const ctx = resolvePageContext(nodes);
    expect(ctx.page?.id).toBe('p1');
    expect(ctx.fellBackToFirstChild).toBe(false);
  });

  it('returns null page when no id and tree is empty', () => {
    const ctx = resolvePageContext([]);
    expect(ctx.page).toBeNull();
  });

  it('resolves a top-level page by id', () => {
    const nodes = [makePage('p1'), makePage('p2')];
    const ctx = resolvePageContext(nodes, 'p2');
    expect(ctx.page?.id).toBe('p2');
    expect(ctx.pageGroups).toEqual([]);
  });

  it('resolves a page inside a top-level group', () => {
    const nodes = [makeGroup('g1', [makePage('p1'), makePage('p2')])];
    const ctx = resolvePageContext(nodes, 'p2');
    expect(ctx.page?.id).toBe('p2');
    expect(ctx.pageGroups.map((g) => g.id)).toEqual(['g1']);
    expect(ctx.fellBackToFirstChild).toBe(false);
  });

  it('returns the full group ancestor chain for a deeply nested page', () => {
    const inner = makeGroup('inner', [makePage('p2')]);
    const outer = makeGroup('outer', [inner]);
    const ctx = resolvePageContext([outer], 'p2');
    expect(ctx.page?.id).toBe('p2');
    expect(ctx.pageGroups.map((g) => g.id)).toEqual(['outer', 'inner']);
  });

  it('falling back to first child when a page-group id is requested', () => {
    const nodes = [makeGroup('g1', [makePage('p1'), makePage('p2')])];
    const ctx = resolvePageContext(nodes, 'g1');
    expect(ctx.page?.id).toBe('p1');
    expect(ctx.fellBackToFirstChild).toBe(true);
    expect(ctx.requestedNode?.id).toBe('g1');
  });

  it('returns null page when id is not found anywhere', () => {
    const ctx = resolvePageContext([makePage('p1')], 'missing');
    expect(ctx.page).toBeNull();
    expect(ctx.pageGroups).toEqual([]);
  });
});
