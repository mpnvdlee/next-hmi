import { EDITOR_NODE_IDS, makePageSectionId } from '@shared/constants/editorSentinels';
import type { DialogConfig, PageNode, ShellRegionId, WidgetConfig } from '@shared/types/config';
import { flattenVisibleRows, rowsBetween, type VisibleRowsInput } from './visibleRows';

const widget = (id: string, children?: WidgetConfig[]): WidgetConfig => ({
  id,
  type: children ? 'Container' : 'Button',
  name: id,
  ...(children ? { children } : {}),
});

const pages: PageNode[] = [
  {
    id: 'page-1',
    type: 'page',
    title: 'One',
    sections: { content: [widget('a'), widget('box', [widget('inner')])] },
  },
  {
    id: 'group-1',
    type: 'page-group',
    title: 'Group',
    header: [widget('group-head')],
    children: [{ id: 'page-2', type: 'page', title: 'Two', sections: { content: [widget('c')] } }],
  },
];

const dialogs: DialogConfig[] = [{ id: 'dlg', title: 'Dialog', widgets: [widget('dlg-btn')] }];

const shell: Record<ShellRegionId, WidgetConfig[]> = {
  header: [widget('head-btn')],
  footer: [],
  leftSidebar: [],
  rightSidebar: [],
};

const ALL_SECTIONS = new Set([
  '__header__',
  '__footer__',
  '__leftSidebar__',
  '__rightSidebar__',
  EDITOR_NODE_IDS.PAGES,
  EDITOR_NODE_IDS.DIALOGS,
]);

function input(overrides: Partial<VisibleRowsInput> = {}): VisibleRowsInput {
  return {
    pages,
    shell,
    dialogs,
    collapsed: new Set<string>(),
    sectionsOpen: ALL_SECTIONS,
    visible: {
      settings: true,
      events: true,
      pages: true,
      dialogs: true,
      hiddenShellRegions: new Set<ShellRegionId>(),
    },
    ...overrides,
  };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('flattenVisibleRows', () => {
  it('walks settings, events, shell, pages and dialogs in render order', () => {
    expect(ids(flattenVisibleRows(input()))).toEqual([
      EDITOR_NODE_IDS.SETTINGS,
      EDITOR_NODE_IDS.EVENTS,
      '__header__',
      'head-btn',
      '__leftSidebar__',
      '__rightSidebar__',
      '__footer__',
      EDITOR_NODE_IDS.PAGES,
      'page-1',
      'a',
      'box',
      'inner',
      'group-1',
      'group-1::header',
      'group-head',
      'page-2',
      'c',
      'group-1::footer',
      EDITOR_NODE_IDS.DIALOGS,
      'dlg',
      'dlg-btn',
    ]);
  });

  it('marks only widget rows as selectable', () => {
    const selectable = flattenVisibleRows(input())
      .filter((row) => row.selectable)
      .map((row) => row.id);

    expect(selectable).toEqual(['head-btn', 'a', 'box', 'inner', 'group-head', 'c', 'dlg-btn']);
  });

  it('hides the subtree of a collapsed container', () => {
    expect(ids(flattenVisibleRows(input({ collapsed: new Set(['box']) })))).not.toContain('inner');
  });

  it('hides pages of a collapsed group but keeps the group row', () => {
    const rows = ids(flattenVisibleRows(input({ collapsed: new Set(['group-1']) })));

    expect(rows).toContain('group-1');
    expect(rows).not.toContain('page-2');
    expect(rows).not.toContain('group-1::header');
  });

  it('hides a section body when its section is closed', () => {
    const rows = ids(flattenVisibleRows(input({ sectionsOpen: new Set([EDITOR_NODE_IDS.PAGES]) })));

    expect(rows).toContain('page-1');
    expect(rows).not.toContain('head-btn');
    expect(rows).not.toContain('dlg');
  });

  it('drops shell sections the search filtered away', () => {
    const rows = ids(
      flattenVisibleRows(
        input({
          visible: {
            settings: false,
            events: false,
            pages: true,
            dialogs: true,
            hiddenShellRegions: new Set<ShellRegionId>([
              'header',
              'footer',
              'leftSidebar',
              'rightSidebar',
            ]),
          },
        }),
      ),
    );

    expect(rows[0]).toBe(EDITOR_NODE_IDS.PAGES);
  });

  it('renders one folder row per explicit page section', () => {
    const sectioned: PageNode[] = [
      {
        id: 'page-3',
        type: 'page',
        title: 'Sectioned',
        showHeader: true,
        sections: { header: [widget('h')], content: [widget('m')] },
      },
    ];
    const rows = ids(flattenVisibleRows(input({ pages: sectioned, dialogs: [] })));

    expect(rows).toContain(makePageSectionId('page-3', 'header'));
    expect(rows).toContain('h');
    expect(rows).toContain('m');
  });

  it('nests page-section widgets one level deeper than the folder', () => {
    const sectioned: PageNode[] = [
      {
        id: 'page-3',
        type: 'page',
        title: 'Sectioned',
        showHeader: true,
        sections: { header: [widget('h')], content: [widget('m')] },
      },
    ];
    const rows = flattenVisibleRows(input({ pages: sectioned, dialogs: [] }));
    const folder = rows.find((r) => r.id === makePageSectionId('page-3', 'header'));
    const child = rows.find((r) => r.id === 'h');

    expect(child?.depth).toBe((folder?.depth ?? 0) + 1);
  });
});

describe('rowsBetween', () => {
  const rows = flattenVisibleRows(input());

  it('slices inclusively in either direction', () => {
    expect(ids(rowsBetween(rows, 'a', 'inner'))).toEqual(['a', 'box', 'inner']);
    expect(ids(rowsBetween(rows, 'inner', 'a'))).toEqual(['a', 'box', 'inner']);
  });

  it('spans across sections, non-selectable rows included', () => {
    expect(ids(rowsBetween(rows, 'head-btn', 'a'))).toEqual([
      'head-btn',
      '__leftSidebar__',
      '__rightSidebar__',
      '__footer__',
      EDITOR_NODE_IDS.PAGES,
      'page-1',
      'a',
    ]);
  });

  it('returns nothing when either end is no longer visible', () => {
    expect(rowsBetween(rows, 'gone', 'a')).toEqual([]);
    expect(rowsBetween(rows, 'a', 'gone')).toEqual([]);
  });
});
