import { render, screen, waitFor } from '@testing-library/react';

const loadCustomWidgets = vi.fn(() => Promise.resolve());
const loadComponents = vi.fn(() => Promise.resolve());

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

const { ComponentsReadyGate } = await import('./AppInner');

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
});
