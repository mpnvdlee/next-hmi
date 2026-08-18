import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import ConfigRoutes from './ConfigRoutes';

// The routed views are code-split; stub each chunk so this file owns the route
// map itself (which path mounts which view) rather than the views' own trees.
vi.mock('../components/shell/ConfigShell', () => ({
  default: () => (
    <div data-testid="shell">
      <Outlet />
    </div>
  ),
}));
vi.mock('./EditorView', () => ({ default: () => <div>EditorView</div> }));
vi.mock('./VariablesView', () => ({ default: () => <div>VariablesView</div> }));
vi.mock('./TranslationsView', () => ({ default: () => <div>TranslationsView</div> }));
vi.mock('./AdminView', () => ({ default: () => <div>AdminView</div> }));
vi.mock('./UsersView', () => ({ default: () => <div>UsersView</div> }));
vi.mock('./ThemesView', () => ({ default: () => <div>ThemesView</div> }));
vi.mock('./AlarmsView', () => ({ default: () => <div>AlarmsView</div> }));
vi.mock('./HistorianView', () => ({ default: () => <div>HistorianView</div> }));
vi.mock('./RecipesView', () => ({ default: () => <div>RecipesView</div> }));
vi.mock('./ComponentsView', () => ({ default: () => <div>ComponentsView</div> }));

/** Mounts ConfigRoutes the way App.tsx does on the legacy `/config/*` mount. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/config/*" element={<ConfigRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  delete window.__NEXTHMI_BASE__;
});

describe('routes', () => {
  it.each([
    ['/config/editor', 'EditorView'],
    ['/config/datasources', 'VariablesView'],
    ['/config/translations', 'TranslationsView'],
    ['/config/theme', 'ThemesView'],
    ['/config/alarms', 'AlarmsView'],
    ['/config/historian', 'HistorianView'],
    ['/config/recipes', 'RecipesView'],
    ['/config/components', 'ComponentsView'],
    ['/config/admin', 'AdminView'],
    ['/config/users', 'UsersView'],
  ])('%s mounts %s inside the config shell', async (path, view) => {
    renderAt(path);

    expect(await screen.findByText(view)).toBeInTheDocument();
    expect(screen.getByTestId('shell')).toBeInTheDocument();
  });

  it('redirects the config index to the page editor', async () => {
    renderAt('/config');

    expect(await screen.findByText('EditorView')).toBeInTheDocument();
  });

  it('leaves an unknown config path unmatched rather than falling back to a view', async () => {
    renderAt('/config/nope');

    await Promise.resolve();
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(screen.queryByText('EditorView')).toBeNull();
  });
});

describe('stale theme preview', () => {
  it('drops a preview payload left in localStorage by an earlier session', async () => {
    localStorage.setItem('hmi_theme_preview', JSON.stringify({ ts: 1, theme: {} }));

    // The clear runs at module scope, so re-evaluate the module to trigger it.
    vi.resetModules();
    await import('./ConfigRoutes');

    expect(localStorage.getItem('hmi_theme_preview')).toBeNull();
  });
});

describe('editor-area mount', () => {
  it('drops the /config prefix from the index redirect under /editor/<slug>/', async () => {
    window.__NEXTHMI_BASE__ = '/editor/p1/';
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/*" element={<ConfigRoutes />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('EditorView')).toBeInTheDocument();
  });
});
