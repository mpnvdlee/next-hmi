import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SaveWarningsPill from './index';
import { useProjectStore } from '@shared/store/projectStore';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { usePanelDiagnosticsStore, type Diagnostic } from '@config/hooks/usePanelDiagnostics';
import { useProjectDiagnosticsStore } from '@config/hooks/useProjectDiagnostics';

function renderPill() {
  return render(
    <MemoryRouter>
      <SaveWarningsPill />
    </MemoryRouter>,
  );
}

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    artifactId: null,
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

/** Stub the project-wide sweep the pill fetches eagerly for its count. */
function stubValidateFetch(diagnostics: Diagnostic[]) {
  const spy = vi.fn((url: string) =>
    Promise.resolve(
      url.includes('/api/config/validate')
        ? { ok: true, status: 200, json: async () => ({ diagnostics }) }
        : { ok: true, status: 204 },
    ),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('SaveWarningsPill', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [
        { id: 'page-1', type: 'page', title: 'Page One', sections: { main: [] } },
        { id: 'page-2', type: 'page', title: 'Page Two', sections: { main: [] } },
      ],
      loadedPageIds: new Set(['page-1', 'page-2']),
    });
    useProjectStore.setState({ dirty: false });
    useEditorDomainStore.setState({
      selectedId: null,
      openTabIds: [],
      previewTabId: null,
      activeTabId: null,
      previewAreaId: '',
    });
    stubValidateFetch([]);
    useProjectDiagnosticsStore.setState({ swept: null, loading: false });
    usePanelDiagnosticsStore.getState().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a muted button when there are no issues', async () => {
    renderPill();
    const button = await screen.findByRole('button', { name: /no issues/i });
    expect(button.className).toContain('cfg-save-warnings__pill--muted');
  });

  it('keeps the pill visible while dirty, marked as predating the edits', async () => {
    useProjectStore.setState({ dirty: true });
    renderPill();
    const button = await screen.findByRole('button', { name: /no issues/i });
    expect(button.className).toContain('cfg-save-warnings__pill--stale');
    expect(button.title).toMatch(/from the last save/i);
  });

  it('replaces a swept artifact rows with the live verdict for it', async () => {
    stubValidateFetch([
      diagnostic({ artifactId: 'page-1', severity: 'error', message: 'stale error' }),
      diagnostic({ artifactId: 'page-2', severity: 'error', message: 'other page error' }),
    ]);
    renderPill();
    await screen.findByRole('button', { name: /2 errors/i });

    // page-1 is now open in a panel and its problem has been fixed.
    usePanelDiagnosticsStore.getState().setDiagnostics([], 'page:page-1');
    const button = await screen.findByRole('button', { name: /1 error/i });

    fireEvent.click(button);
    expect(screen.queryByText('stale error')).not.toBeInTheDocument();
    expect(screen.getByText('other page error')).toBeInTheDocument();
  });

  it('shows the error/warning counts in the button and lists messages', async () => {
    stubValidateFetch([
      diagnostic({
        artifactId: 'page-1',
        severity: 'error',
        message: 'bad var',
        code: 'var-unknown',
      }),
      diagnostic({
        artifactId: 'page-2',
        severity: 'warning',
        message: 'unset condition',
        code: 'if-condition-empty',
      }),
    ]);
    renderPill();

    const button = await screen.findByRole('button', { name: /1 error · 1 warning/i });
    expect(button.className).not.toContain('cfg-save-warnings__pill--muted');

    fireEvent.click(button);
    expect(screen.getByText('bad var')).toBeInTheDocument();
    expect(screen.getByText('unset condition')).toBeInTheDocument();
  });

  it('labels rows by artifact kind', async () => {
    stubValidateFetch([
      diagnostic({ artifactKind: 'shell', artifactId: 'shell', message: 'shell issue' }),
      diagnostic({
        artifactKind: 'globalEvents',
        artifactId: 'globalEvents',
        message: 'events issue',
      }),
      diagnostic({ artifactKind: 'component', artifactId: 'my-comp', message: 'component issue' }),
    ]);
    renderPill();
    fireEvent.click(await screen.findByRole('button', { name: /warning/i }));

    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('Global Events')).toBeInTheDocument();
    expect(screen.getByText('Component: my-comp')).toBeInTheDocument();
  });

  it('closes the popup and selects the diagnosed widget in the widget tree', async () => {
    useConfigStore.setState({
      pages: [
        {
          id: 'page-1',
          type: 'page',
          title: 'Page One',
          sections: {
            main: [
              {
                id: 'container-1',
                type: 'Container',
                name: 'Container',
                children: [{ id: 'widget-1', type: 'Text', name: 'Warned widget' }],
              },
            ],
          },
        },
      ],
      loadedPageIds: new Set(['page-1']),
    });
    stubValidateFetch([
      diagnostic({
        artifactKind: 'page',
        artifactId: 'page-1',
        widgetId: 'widget-1',
        propKey: 'value',
        message: 'bad nested var',
        breadcrumb: 'Warned widget › value',
      }),
    ]);
    renderPill();

    fireEvent.click(await screen.findByRole('button', { name: /warning/i }));
    fireEvent.click(screen.getByRole('button', { name: /bad nested var/i }));

    expect(screen.queryByRole('dialog', { name: 'Build diagnostics' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(useEditorDomainStore.getState().selectedId).toBe('widget-1');
      expect(useEditorDomainStore.getState().previewAreaId).toBe('page-1');
    });
  });
});
