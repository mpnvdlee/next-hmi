// Renders the widget directly, as its own module does at runtime: bind the SDK
// globals it references as free identifiers. The TabBar inside a page-group
// header band is another built-in widget, and resolves through the same shim.
import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import type { PageConfig, PageNode, WidgetConfig } from '@shared/types/config';
import { PreviewContext } from '@shared/context/PreviewContext';
import { matchesSearchWords } from '@shared/utils/search';
import { filterHidden, filterByRole, sortPagesByOrder } from '@shared/utils/pageTree';
import NavigationMenu from './index';
import PageGroupPageView from '@hmi/components/PageGroupPageView';

function mkPage(id: string, title: string, widgets: WidgetConfig[] = []): PageConfig {
  return { id, type: 'page', title, sections: { content: widgets } };
}

describe('NavigationMenu routing', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [],
      header: [],
      footer: [],
      dialogs: [],
      loaded: true,
    });
    // Signed out: role gating counts an anonymous viewer as a member of nothing.
    useHmiStore.setState({ currentUsersByScope: {} });
  });

  it('navigates between runtime pages', async () => {
    useConfigStore.setState({
      pages: runtimePages(),
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/pages/page-1']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Page 2/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/pages/page-2');
    });
  });

  it('navigates between preview pages', async () => {
    useConfigStore.setState({
      pages: runtimePages(),
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/preview/page-1']}>
        <PreviewContext.Provider value={true}>
          <Routes>
            <Route path="/preview/:id" element={<RuntimeShell routeBase="/preview" />} />
          </Routes>
        </PreviewContext.Provider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Page 2/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/preview/page-2');
    });
  });

  it('falls back from a page-group route to its first child page', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          children: [mkPage('child-1', 'Child 1'), mkPage('child-2', 'Child 2')],
        },
      ] satisfies PageNode[],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/pages/child-2']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Group 1/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/pages/child-1');
    });
  });

  it('hides child pages in menu when page-group option is disabled', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: false,
          children: [mkPage('child-1', 'Child 1')],
        },
      ] satisfies PageNode[],
    });

    render(
      <MemoryRouter initialEntries={['/pages/child-1']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    const childButtons = screen.queryAllByRole('button', { name: /Child 1/i });
    expect(childButtons).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Group 1/i })).toHaveAttribute('data-active', 'true');
  });

  it('shows child pages in menu when page-group option is enabled', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [mkPage('child-1', 'Child 1')],
        },
      ] satisfies PageNode[],
    });

    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/pages/group-1']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /Child 1/i }));

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/pages/child-1');
    });
  });

  it('reveals nested page-group pages on toggle', async () => {
    const user = userEvent.setup();

    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [
            mkPage('child-1', 'Child 1'),
            {
              id: 'group-2',
              type: 'page-group',
              title: 'Group 2',
              showChildPagesInMenu: true,
              children: [mkPage('child-2', 'Child 2')],
            },
          ],
        },
      ] satisfies PageNode[],
    });

    render(
      <MemoryRouter initialEntries={['/pages/child-1']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Child 1/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Child 2/i })).toBeNull();

    await user.click(screen.getByTestId('group-toggle-group-2'));
    expect(screen.getByRole('button', { name: /Child 2/i })).toBeInTheDocument();
  });

  it('gates a nested role-restricted page by the same groups as the top level', async () => {
    // Regression: the nested levels once resolved the viewer's groups through
    // `useEvalContext().resolveUserGroups()`, which answers ['guest'] for an
    // anonymous viewer so a `$userGroups` gate naming `guest` matches. Page
    // `role` gating counts an anonymous viewer as a member of nothing, and the
    // top level (via `useVisiblePages`) always did — so one menu listed a nested
    // page gated on `guest` while hiding an identically gated top-level one.
    useConfigStore.setState({
      pages: [
        { ...mkPage('top-guest', 'Top Guest'), role: ['guest'] },
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [
            mkPage('child-open', 'Child Open'),
            { ...mkPage('child-guest', 'Child Guest'), role: ['guest'] },
          ],
        },
      ] satisfies PageNode[],
    });

    const shell = (
      <MemoryRouter initialEntries={['/pages/child-open']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>
    );

    const anonymous = render(shell);
    expect(screen.getByRole('button', { name: /Child Open/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top Guest/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Child Guest/i })).toBeNull();
    anonymous.unmount();

    // And the gate still opens for a real member, at both levels.
    useHmiStore.setState({
      currentUsersByScope: {
        'runtime:preview': { username: 'op', groups: ['guest'], groupLabels: {} },
      },
    });
    render(shell);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Top Guest/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Child Guest/i })).toBeInTheDocument();
  });

  it("renders the outer group's header widgets when on a page inside a nested group", () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'outer',
          type: 'page-group',
          title: 'Outer',
          showChildPagesInMenu: true,
          header: [
            {
              id: 'outer-banner',
              type: 'FixedSpacer',
              name: 'Outer banner',
            },
          ],
          children: [
            mkPage('first-page', 'First'),
            {
              id: 'inner',
              type: 'page-group',
              title: 'Inner',
              showChildPagesInMenu: true,
              children: [mkPage('inner-page', 'Inner Page')],
            },
          ],
        },
      ] satisfies PageNode[],
    });

    const { container } = render(
      <MemoryRouter initialEntries={['/pages/inner-page']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    // The outer group's shell — with its header band — must wrap whatever sub-page
    // is active, even when that sub-page lives inside a nested group.
    expect(container.querySelector('[data-page-group-id="outer"]')).not.toBeNull();
    expect(
      container.querySelector('[data-page-group-id="outer"] .hmi-page-group-shell__header'),
    ).not.toBeNull();
    expect(container.querySelector('[data-page-id="inner-page"]')).not.toBeNull();
  });

  it("scopes header-band widgets to their own group's tabs (not the innermost active group)", async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'outer',
          type: 'page-group',
          title: 'Outer',
          showChildPagesInMenu: true,
          header: [
            // TabBar inside outer's header — no `groupId`, so it must default to
            // its own group (outer) and show outer's children, not the deepest
            // active group's children.
            { id: 'outer-tabs', type: 'TabBar', name: 'Outer tabs' },
          ],
          children: [
            mkPage('first-page', 'First'),
            {
              id: 'inner',
              type: 'page-group',
              title: 'Inner',
              showChildPagesInMenu: true,
              children: [mkPage('alpha', 'Alpha'), mkPage('beta', 'Beta')],
            },
          ],
        },
      ] satisfies PageNode[],
    });

    const { container } = render(
      <MemoryRouter initialEntries={['/pages/alpha']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    const headerBand = container.querySelector(
      '[data-page-group-id="outer"] .hmi-page-group-shell__header',
    );
    expect(headerBand).not.toBeNull();
    // The TabBar inside outer's header must render outer's children as tabs —
    // "First" and "Inner". It must NOT render the inner group's pages
    // ("Alpha", "Beta") which are the innermost active group's children.
    await waitFor(() => {
      const tabs = Array.from(headerBand!.querySelectorAll('[role="tab"]')).map((t) =>
        (t.textContent ?? '').trim(),
      );
      expect(tabs).toEqual(['First', 'Inner']);
    });
  });

  it('highlights active page and active parent entries for nested group routes', () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [
            {
              id: 'group-2',
              type: 'page-group',
              title: 'Group 2',
              showChildPagesInMenu: true,
              children: [mkPage('child-2', 'Child 2')],
            },
          ],
        },
      ] satisfies PageNode[],
    });

    render(
      <MemoryRouter initialEntries={['/pages/child-2']}>
        <Routes>
          <Route path="/pages/:id" element={<RuntimeShell routeBase="/pages" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Group 1/i })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: /Group 2/i })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: /Child 2/i })).toHaveAttribute('data-active', 'true');
  });

  it('persists group expansion toggles to localStorage under remember mode', async () => {
    window.localStorage.clear();
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [mkPage('child-1', 'Child 1')],
        },
      ] satisfies PageNode[],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/pages/group-1']}>
        <NavigationMenu properties={{ groupExpansion: 'remember' }} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: /Child 1/i })).toBeNull();

    await user.click(screen.getByTestId('group-toggle-group-1'));

    expect(screen.getByRole('button', { name: /Child 1/i })).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem('nexthmi.navmenu.expanded.default') ?? '{}',
      );
      expect(stored).toEqual({ 'group-1': true });
    });
  });

  it('restores expansion state from localStorage on remount under remember mode', () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'nexthmi.navmenu.expanded.default',
      JSON.stringify({ 'group-1': true }),
    );
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children: [mkPage('child-1', 'Child 1')],
        },
      ] satisfies PageNode[],
    });

    render(
      <MemoryRouter initialEntries={['/pages/group-1']}>
        <NavigationMenu properties={{ groupExpansion: 'remember' }} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /Child 1/i })).toBeInTheDocument();
  });

  it('matches unordered words across a page and its parent path', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'production',
          type: 'page-group',
          title: 'Production',
          showChildPagesInMenu: true,
          children: [
            mkPage('motor-overview', 'Motor Overview'),
            mkPage('pressure-overview', 'Pressure Overview'),
          ],
        },
      ] satisfies PageNode[],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/pages/motor-overview']}>
        <NavigationMenu properties={{ showSearch: true }} />
      </MemoryRouter>,
    );

    await user.type(screen.getByRole('searchbox'), 'motor production');

    expect(screen.getByRole('button', { name: /Motor Overview/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pressure Overview/i })).toBeNull();
  });

  // The widget's matchesSearchWords is a render-time twin of the shared one
  // (module-private, so it can't just be imported and compared directly) —
  // pin it against the shared implementation's own verdict instead of a
  // hand-picked expectation, so the two can't quietly diverge.
  it('filters search results exactly as the shared matchesSearchWords would', async () => {
    useConfigStore.setState({
      pages: [
        mkPage('motor-overview', 'MOTOR Overview'),
        mkPage('pressure-overview', 'Pressure Overview'),
      ],
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/pages/motor-overview']}>
        <NavigationMenu properties={{ showSearch: true }} />
      </MemoryRouter>,
    );

    const input = screen.getByRole('searchbox');
    const probes = ['  overview   motor  ', 'OVERVIEW pressure', 'motor pressure', 'zzz'];
    for (const query of probes) {
      await user.clear(input);
      await user.type(input, query);

      const wantMotor = matchesSearchWords(query, ['MOTOR Overview']);
      const wantPressure = matchesSearchWords(query, ['Pressure Overview']);
      expect(!!screen.queryByRole('button', { name: /Motor Overview/i })).toBe(wantMotor);
      expect(!!screen.queryByRole('button', { name: /Pressure Overview/i })).toBe(wantPressure);
    }
  });

  // The widget's own applyMetadataFilters is a render-time twin of composing
  // filterHidden + filterByRole + sortPagesByOrder from @shared/utils/pageTree
  // (a widget module carries no app imports) — pin the rendered children
  // against what composing the shared functions would produce, so the two
  // can't quietly diverge.
  it("filters and orders a group's children exactly as the shared pageTree helpers would", () => {
    const children: PageNode[] = [
      { ...mkPage('page-a', 'Alpha'), order: 2 },
      { ...mkPage('page-b', 'Beta'), hidden: true },
      { ...mkPage('page-c', 'Charlie'), role: ['ops'] },
      { ...mkPage('page-d', 'Delta'), order: 1 },
    ];
    useConfigStore.setState({
      pages: [
        {
          id: 'group-1',
          type: 'page-group',
          title: 'Group 1',
          showChildPagesInMenu: true,
          children,
        },
      ] satisfies PageNode[],
    });

    render(
      <MemoryRouter initialEntries={['/pages/group-1']}>
        <NavigationMenu properties={{ groupExpansion: 'all-expanded', iconStrategy: 'none' }} />
      </MemoryRouter>,
    );

    const expected = sortPagesByOrder(filterByRole(filterHidden(children), [])).map(
      (n) => n.title as string,
    );
    const rendered = screen
      .getAllByRole('button')
      .map((btn) => btn.textContent)
      .filter((text): text is string => !!text && children.some((c) => c.title === text));

    expect(rendered).toEqual(expected);
  });
});

function RuntimeShell({ routeBase }: { routeBase: '/pages' | '/preview' }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pages = useConfigStore((state) => state.pages);

  return (
    <>
      <NavigationMenu />
      <PageGroupPageView
        pages={pages}
        requestedId={id}
        onNavigate={(pageId, replace) =>
          navigate(`${routeBase}/${pageId}`, { replace: replace ?? false })
        }
      />
      <PathDisplay />
    </>
  );
}

function PathDisplay() {
  const location = useLocation();

  return <output data-testid="path">{location.pathname}</output>;
}

function runtimePages(): PageNode[] {
  return [mkPage('page-1', 'Page 1'), mkPage('page-2', 'Page 2')];
}
