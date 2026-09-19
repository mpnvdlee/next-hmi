import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const loadCustomWidgets = vi.fn(() => Promise.resolve());
const loadComponents = vi.fn(() => Promise.resolve());

vi.mock('@config/pages/ConfigRoutes', () => ({
  default: () => <div>config routes</div>,
}));

vi.mock('@hmi/store/deviceInfoStore', () => ({
  useDeviceInfoStore: { getState: () => ({ fetch: () => {} }) },
}));

vi.mock('@hmi/registry/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hmi/registry/widgetRegistry')>();
  return {
    ...actual,
    loadCustomWidgets: () => loadCustomWidgets(),
    loadComponents: () => loadComponents(),
    prefetchBuiltinWidgetModules: () => Promise.resolve(),
  };
});

vi.mock('@shared/utils/themeTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/themeTokens')>()),
  // The only two that would reach the network from a bare unit test.
  ensureThemeTokens: () => Promise.resolve(),
  loadAndApplyThemeTokens: () => Promise.resolve(),
}));

vi.mock('@hmi/hooks/useWebSocket', () => ({ useWebSocket: () => {} }));

const { ComponentsReadyGate, default: AppInner } = await import('./AppInner');

describe('ComponentsReadyGate', () => {
  it('opens even when the route chunk fails to load', async () => {
    // A stale chunk hash after a redeploy rejects the preload. The route's own
    // Suspense and error boundary are behind this gate — a rejected gate just
    // leaves the boot splash up with nothing to look at.
    render(
      <ComponentsReadyGate preload={() => Promise.reject(new Error('stale chunk'))}>
        <div>route content</div>
      </ComponentsReadyGate>,
    );

    await waitFor(() => expect(screen.getByText('route content')).toBeInTheDocument());
  });

  it('opens once everything it waits on has landed', async () => {
    render(
      <ComponentsReadyGate preload={() => Promise.resolve()}>
        <div>route content</div>
      </ComponentsReadyGate>,
    );

    await waitFor(() => expect(screen.getByText('route content')).toBeInTheDocument());
  });

  it('holds the bare boot state in the app palette', async () => {
    // The project accent does not exist until /api/themes lands — and in the
    // preview iframe a Themes draft can repaint it once more after that. A boot
    // spinner drawn from it therefore changes colour twice on the way up, under
    // a fallback that is a third colour again. The splash branch is app-palette
    // for exactly this reason; the bare branch has to match it.
    const { container } = render(
      <ComponentsReadyGate preload={() => new Promise<void>(() => {})}>
        <div>route content</div>
      </ComponentsReadyGate>,
    );

    await waitFor(() => expect(container.querySelector('.app-spinner')).toBeInTheDocument());
    expect(container.querySelector('.app-spinner')).toHaveClass('app-spinner--cfg');
  });
});

describe('the /config route in the runtime route map', () => {
  afterEach(() => {
    delete window.__NEXTHMI_BASE__;
  });

  function renderAt(base: string | undefined, path: string) {
    if (base === undefined) delete window.__NEXTHMI_BASE__;
    else window.__NEXTHMI_BASE__ = base;
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AppInner />
      </MemoryRouter>,
    );
  }

  it('is mounted everywhere but under a /runtime/<slug>/ base', async () => {
    // The manager serves /runtime/<slug>/ with no device-admin session, so
    // mounting the editor there would hand an editor shell to an anonymous
    // visitor — whose writes the gate refuses anyway.
    const runtime = renderAt('/runtime/plant-a/', '/config/pages');
    // Long enough for a matching route's lazy chunk to resolve and paint. The
    // absence below says nothing without it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText('config routes')).not.toBeInTheDocument();
    runtime.unmount();

    // `getArea()` is null at "/" — dev and a bare instance — where
    // `editorPath()` still emits /config/... and this route is the only way in.
    renderAt(undefined, '/config/pages');
    expect(await screen.findByText('config routes')).toBeInTheDocument();
  });
});
